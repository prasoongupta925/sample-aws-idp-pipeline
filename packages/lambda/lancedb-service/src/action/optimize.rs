use lancedb::index::{Index, IndexType};
use lancedb::table::{CompactionOptions, Duration, OptimizeAction};
use lancedb::{Connection, Table};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::db;

/// Table versions kept when the caller does not say: the last 24 hours.
pub const DEFAULT_OLDER_THAN_HOURS: u32 = 24;
/// Nothing may be kept longer than 7 days.
pub const MAX_OLDER_THAN_HOURS: u32 = 7 * 24;

/// A delete only hides rows: the files that hold them stay in S3, referenced by
/// older table versions (and by the FTS index built before the delete). This
/// action removes them physically: it compacts the table (rewriting every
/// fragment that has deleted rows), rebuilds its FTS indices and prunes the
/// versions older than `older_than_hours`, which deletes the files only those
/// versions used.
#[derive(Deserialize)]
pub struct OptimizeParams {
    /// Table to clean up, as in drop_table: a project's table (the project id),
    /// "{project_id}_datasets" or "graph_keywords". Every table when absent.
    pub project_id: Option<String>,
    /// Keep the versions of the last N hours (default 24, at most 168). 0 keeps
    /// only the latest version, so the deleted rows are gone when the call
    /// returns.
    pub older_than_hours: Option<u32>,
}

#[derive(Serialize)]
pub struct OptimizedTable {
    pub table: String,
    pub fragments_removed: usize,
    pub fragments_added: usize,
    pub fts_indices_rebuilt: usize,
    pub old_versions_removed: u64,
    pub bytes_removed: u64,
}

#[derive(Serialize)]
pub struct OptimizeOutput {
    pub success: bool,
    pub tables: Vec<OptimizedTable>,
}

pub async fn execute(
    conn: &Connection,
    params: OptimizeParams,
) -> lancedb::error::Result<OptimizeOutput> {
    let hours = params.older_than_hours.unwrap_or(DEFAULT_OLDER_THAN_HOURS);
    let older_than = match Duration::try_hours(i64::from(hours)) {
        Some(duration) if hours <= MAX_OLDER_THAN_HOURS => duration,
        _ => {
            return Err(lancedb::error::Error::InvalidInput {
                message: format!(
                    "older_than_hours must be at most {MAX_OLDER_THAN_HOURS} (7 days), got {hours}"
                ),
            });
        }
    };

    let table_names = db::table::list_tables(conn).await?;
    let targets = match params.project_id {
        Some(name) if table_names.contains(&name) => vec![name],
        Some(name) => {
            info!("[optimize] Table not found: {name}, skipping");
            vec![]
        }
        None => table_names,
    };

    // One table's failure does not stop the others; the call still fails.
    let mut tables = Vec::with_capacity(targets.len());
    let mut failed = Vec::new();
    for name in &targets {
        match optimize_table(conn, name, older_than).await {
            Ok(stats) => tables.push(stats),
            Err(e) => {
                warn!("[optimize] Table {name} failed: {e}");
                failed.push(format!("{name}: {e}"));
            }
        }
    }
    if !failed.is_empty() {
        return Err(lancedb::error::Error::Runtime {
            message: format!(
                "optimize failed for {} of {} table(s): {}",
                failed.len(),
                targets.len(),
                failed.join("; ")
            ),
        });
    }

    Ok(OptimizeOutput {
        success: true,
        tables,
    })
}

async fn optimize_table(
    conn: &Connection,
    name: &str,
    older_than: Duration,
) -> lancedb::error::Result<OptimizedTable> {
    info!("[optimize] Opening table: {name}");
    let table = conn.open_table(name).execute().await?;

    // 1. Compaction. Threshold 0: rewrite every fragment with a deleted row (the
    //    default 10% would keep a few deleted rows in place for good). Small
    //    fragments (add_record writes one row each) are merged too.
    let mut options = CompactionOptions::default();
    options.materialize_deletions_threshold = 0.0;
    let compaction = table
        .optimize(OptimizeAction::Compact {
            options,
            remap_options: None,
        })
        .await?
        .compaction
        .unwrap_or_default();
    info!(
        "[optimize] {name}: compaction removed {} and added {} fragment(s)",
        compaction.fragments_removed, compaction.fragments_added
    );

    // 2. FTS indices keep the tokens of rows deleted after they were built.
    let fts_indices_rebuilt = rebuild_fts_indices(&table, name).await?;

    // 3. Prune old versions. delete_unverified stays false: a file no version
    //    references yet may belong to a write in progress, and is only deleted
    //    once it is 7 days old.
    let prune = table
        .optimize(OptimizeAction::Prune {
            older_than: Some(older_than),
            delete_unverified: Some(false),
            error_if_tagged_old_versions: None,
        })
        .await?
        .prune
        .unwrap_or_default();
    info!(
        "[optimize] {name}: pruned {} old version(s), {} bytes",
        prune.old_versions, prune.bytes_removed
    );

    Ok(OptimizedTable {
        table: name.to_string(),
        fragments_removed: compaction.fragments_removed,
        fragments_added: compaction.fragments_added,
        fts_indices_rebuilt,
        old_versions_removed: prune.old_versions,
        bytes_removed: prune.bytes_removed,
    })
}

/// Rebuilds each FTS index from the rows left, with the settings the search
/// actions create it with. Other index types are not created by this service.
async fn rebuild_fts_indices(table: &Table, name: &str) -> lancedb::error::Result<usize> {
    let mut rebuilt = 0;
    for index in table.list_indices().await? {
        if index.index_type != IndexType::FTS {
            info!(
                "[optimize] {name}: {} index {} left as is",
                index.index_type, index.name
            );
            continue;
        }
        info!(
            "[optimize] {name}: rebuilding FTS index {} on {:?}",
            index.name, index.columns
        );
        table
            .create_index(&index.columns, Index::FTS(Default::default()))
            .name(index.name)
            .replace(true)
            .execute()
            .await?;
        rebuilt += 1;
    }
    Ok(rebuilt)
}
