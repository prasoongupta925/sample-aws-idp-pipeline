//! The optimize action on a local LanceDB folder: runs without AWS
//! (`cargo test --test optimize_local`). All data is synthetic.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use arrow_array::{
    FixedSizeListArray, Float32Array, Int64Array, RecordBatch, StringArray,
    TimestampMicrosecondArray,
};
use arrow_schema::{DataType, Field};
use futures::TryStreamExt;
use lance_index::scalar::FullTextSearchQuery;
use lancedb::Connection;
use lancedb::index::Index;
use lancedb::query::{ExecutableQuery, QueryBase};
use lancedb_service::LanceDbAction;
use lancedb_service::action::{delete_by_workflow, optimize};
use lancedb_service::db::model::document_record_schema;

const TABLE: &str = "proj_optimize_test";
// Only in the rows of the erased workflow.
const MARKER: &str = "erasedapplicantmarker";

fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_test_writer()
        .try_init();
}

/// A fresh folder per test, removed when the test ends.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "lancedb-optimize-{name}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    /// Like db::connect: every read sees the latest version.
    async fn connect(&self) -> Connection {
        lancedb::connect(self.0.to_str().unwrap())
            .read_consistency_interval(Duration::ZERO)
            .execute()
            .await
            .unwrap()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Document records (one row each) in the add_record layout.
fn records(rows: &[(&str, i64, &str)]) -> RecordBatch {
    let n = rows.len();
    let segment_ids: Vec<String> = rows
        .iter()
        .map(|(wf, seg, _)| format!("{wf}_{seg:04}"))
        .collect();
    let qa_ids: Vec<String> = segment_ids.iter().map(|s| format!("{s}_00")).collect();
    let values = Arc::new(Float32Array::from(vec![0.5_f32; n * 1024])) as arrow_array::ArrayRef;
    let field = Arc::new(Field::new("item", DataType::Float32, true));
    RecordBatch::try_new(
        document_record_schema(),
        vec![
            Arc::new(StringArray::from_iter_values(rows.iter().map(|r| r.0))),
            Arc::new(StringArray::from_iter_values(
                rows.iter().map(|r| format!("doc_{}", r.0)),
            )),
            Arc::new(StringArray::from(segment_ids.clone())),
            Arc::new(StringArray::from(qa_ids)),
            Arc::new(Int64Array::from_iter_values(rows.iter().map(|r| r.1))),
            Arc::new(Int64Array::from(vec![0_i64; n])),
            Arc::new(StringArray::from(vec![""; n])),
            Arc::new(StringArray::from_iter_values(rows.iter().map(|r| r.2))),
            Arc::new(FixedSizeListArray::new(field, 1024, values, None)),
            Arc::new(StringArray::from_iter_values(rows.iter().map(|r| r.2))),
            Arc::new(StringArray::from(vec!["s3://test/file.pdf"; n])),
            Arc::new(StringArray::from(vec!["application/pdf"; n])),
            Arc::new(StringArray::from(vec![None::<&str>; n])),
            Arc::new(TimestampMicrosecondArray::from(vec![0_i64; n])),
        ],
    )
    .unwrap()
}

const KEPT: &str = "salary slip keptapplicant income";
const ERASED: &str = "pan card erasedapplicantmarker address";

/// A project table like the pipeline writes it: one add per row, an FTS index
/// built by a search, rows added after it, and one batch mixing both workflows.
async fn project_table(conn: &Connection, name: &str) -> lancedb::Table {
    let table = conn
        .create_empty_table(name, document_record_schema())
        .execute()
        .await
        .unwrap();
    for row in [
        ("wf_kept", 0, KEPT),
        ("wf_erased", 0, ERASED),
        ("wf_kept", 1, KEPT),
        ("wf_erased", 1, ERASED),
    ] {
        table.add(records(&[row])).execute().await.unwrap();
    }
    table
        .create_index(&["keywords"], Index::FTS(Default::default()))
        .replace(true)
        .execute()
        .await
        .unwrap();
    table
        .add(records(&[("wf_erased", 2, ERASED)]))
        .execute()
        .await
        .unwrap();
    table
        .add(records(&[("wf_kept", 2, KEPT), ("wf_erased", 3, ERASED)]))
        .execute()
        .await
        .unwrap();
    table
}

async fn erase_workflow(conn: &Connection, name: &str) {
    delete_by_workflow::execute(
        conn,
        delete_by_workflow::DeleteByWorkflowParams {
            project_id: name.to_string(),
            workflow_id: "wf_erased".to_string(),
        },
    )
    .await
    .unwrap();
}

/// Files under `dir` whose bytes contain `needle`.
fn files_containing(dir: &Path, needle: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(path) = stack.pop() {
        if path.is_dir() {
            for entry in std::fs::read_dir(&path).unwrap() {
                stack.push(entry.unwrap().path());
            }
        } else {
            let bytes = std::fs::read(&path).unwrap();
            if bytes.windows(needle.len()).any(|w| w == needle.as_bytes()) {
                found.push(path);
            }
        }
    }
    found
}

async fn fts_hits(table: &lancedb::Table, word: &str) -> usize {
    let batches: Vec<RecordBatch> = table
        .query()
        .full_text_search(FullTextSearchQuery::new(word.to_string()))
        .execute()
        .await
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    batches.iter().map(|b| b.num_rows()).sum()
}

#[tokio::test]
async fn test_optimize_physically_removes_deleted_rows() {
    init_tracing();
    let dir = TempDir::new("erase");
    let conn = dir.connect().await;
    let table = project_table(&conn, TABLE).await;

    erase_workflow(&conn, TABLE).await;
    assert_eq!(table.count_rows(None).await.unwrap(), 3);
    // A delete only hides the rows: their files are still there.
    assert!(!files_containing(&dir.0, MARKER).is_empty());

    let output = optimize::execute(
        &conn,
        optimize::OptimizeParams {
            project_id: Some(TABLE.to_string()),
            older_than_hours: Some(0),
        },
    )
    .await
    .unwrap();
    println!("output: {}", serde_json::to_value(&output).unwrap());

    assert!(output.success);
    assert_eq!(output.tables.len(), 1);
    let stats = &output.tables[0];
    assert_eq!(stats.table, TABLE);
    assert!(stats.fragments_removed > 0);
    assert_eq!(stats.fts_indices_rebuilt, 1);
    assert!(stats.old_versions_removed > 0);
    assert!(stats.bytes_removed > 0);

    // Nothing of the erased rows is left on disk (data, deletion, index or
    // manifest files), and only the latest version remains.
    assert_eq!(files_containing(&dir.0, MARKER), Vec::<PathBuf>::new());
    let table = conn.open_table(TABLE).execute().await.unwrap();
    assert_eq!(table.list_versions().await.unwrap().len(), 1);

    // The kept rows and their search still work.
    assert_eq!(table.count_rows(None).await.unwrap(), 3);
    assert_eq!(
        table
            .count_rows(Some("workflow_id = 'wf_erased'".to_string()))
            .await
            .unwrap(),
        0
    );
    assert_eq!(fts_hits(&table, "keptapplicant").await, 3);
    assert_eq!(fts_hits(&table, MARKER).await, 0);
}

#[tokio::test]
async fn test_optimize_default_window_keeps_recent_versions() {
    init_tracing();
    let dir = TempDir::new("window");
    let conn = dir.connect().await;
    let table = project_table(&conn, TABLE).await;
    erase_workflow(&conn, TABLE).await;
    let versions_before = table.list_versions().await.unwrap().len();

    // Default: versions of the last 24 hours are kept (and the files they use).
    let output = optimize::execute(
        &conn,
        optimize::OptimizeParams {
            project_id: Some(TABLE.to_string()),
            older_than_hours: None,
        },
    )
    .await
    .unwrap();

    assert_eq!(output.tables[0].old_versions_removed, 0);
    let table = conn.open_table(TABLE).execute().await.unwrap();
    assert!(table.list_versions().await.unwrap().len() > versions_before);
    assert!(!files_containing(&dir.0, MARKER).is_empty());
    // The current version already holds no erased row.
    assert_eq!(table.count_rows(None).await.unwrap(), 3);
    assert_eq!(fts_hits(&table, MARKER).await, 0);
}

#[tokio::test]
async fn test_optimize_every_table_and_missing_table() {
    init_tracing();
    let dir = TempDir::new("all");
    let conn = dir.connect().await;
    project_table(&conn, "proj_a").await;
    project_table(&conn, "proj_b").await;
    erase_workflow(&conn, "proj_a").await;
    erase_workflow(&conn, "proj_b").await;

    // An unknown table is skipped, like delete_by_workflow does.
    let output = optimize::execute(
        &conn,
        optimize::OptimizeParams {
            project_id: Some("proj_missing".to_string()),
            older_than_hours: Some(0),
        },
    )
    .await
    .unwrap();
    assert!(output.success);
    assert!(output.tables.is_empty());
    assert!(!files_containing(&dir.0, MARKER).is_empty());

    // No project_id: every table.
    let output = optimize::execute(
        &conn,
        optimize::OptimizeParams {
            project_id: None,
            older_than_hours: Some(0),
        },
    )
    .await
    .unwrap();
    let mut names: Vec<&str> = output.tables.iter().map(|t| t.table.as_str()).collect();
    names.sort();
    assert_eq!(names, ["proj_a", "proj_b"]);
    assert_eq!(files_containing(&dir.0, MARKER), Vec::<PathBuf>::new());
}

#[tokio::test]
async fn test_optimize_table_left_empty() {
    init_tracing();
    let dir = TempDir::new("empty");
    let conn = dir.connect().await;
    let table = conn
        .create_empty_table(TABLE, document_record_schema())
        .execute()
        .await
        .unwrap();
    for seg in 0..2 {
        table
            .add(records(&[("wf_erased", seg, ERASED)]))
            .execute()
            .await
            .unwrap();
    }
    table
        .create_index(&["keywords"], Index::FTS(Default::default()))
        .replace(true)
        .execute()
        .await
        .unwrap();
    erase_workflow(&conn, TABLE).await;

    let output = optimize::execute(
        &conn,
        optimize::OptimizeParams {
            project_id: Some(TABLE.to_string()),
            older_than_hours: Some(0),
        },
    )
    .await
    .unwrap();

    assert_eq!(output.tables.len(), 1);
    assert_eq!(files_containing(&dir.0, MARKER), Vec::<PathBuf>::new());
    let table = conn.open_table(TABLE).execute().await.unwrap();
    assert_eq!(table.count_rows(None).await.unwrap(), 0);
}

#[tokio::test]
async fn test_optimize_window_is_at_most_7_days() {
    init_tracing();
    let dir = TempDir::new("cap");
    let conn = dir.connect().await;
    project_table(&conn, TABLE).await;
    let versions = |conn: Connection| async move {
        let table = conn.open_table(TABLE).execute().await.unwrap();
        table.list_versions().await.unwrap().len()
    };
    let before = versions(conn.clone()).await;

    let result = optimize::execute(
        &conn,
        optimize::OptimizeParams {
            project_id: Some(TABLE.to_string()),
            older_than_hours: Some(optimize::MAX_OLDER_THAN_HOURS + 1),
        },
    )
    .await;

    let error = result
        .err()
        .expect("a window over 7 days is refused")
        .to_string();
    assert!(
        error.contains("older_than_hours must be at most 168"),
        "{error}"
    );
    assert_eq!(versions(conn.clone()).await, before); // nothing was touched
}

#[test]
fn test_optimize_action_payload() {
    let action: LanceDbAction = serde_json::from_value(serde_json::json!({
        "action": "optimize",
        "params": {"project_id": "proj_x", "older_than_hours": 0},
    }))
    .unwrap();
    assert!(matches!(
        action,
        LanceDbAction::Optimize(optimize::OptimizeParams {
            project_id: Some(ref p),
            older_than_hours: Some(0),
        }) if p == "proj_x"
    ));

    let action: LanceDbAction = serde_json::from_value(serde_json::json!({
        "action": "optimize",
        "params": {},
    }))
    .unwrap();
    assert!(matches!(
        action,
        LanceDbAction::Optimize(optimize::OptimizeParams {
            project_id: None,
            older_than_hours: None,
        })
    ));
}

/// The retention sweeper lists the tables before optimizing them, and sends
/// list_tables without params: the unit action rejects even an empty object.
#[test]
fn test_list_tables_payload_takes_no_params() {
    let action: LanceDbAction =
        serde_json::from_value(serde_json::json!({"action": "list_tables"})).unwrap();
    assert!(matches!(action, LanceDbAction::ListTables));

    let rejected = serde_json::from_value::<LanceDbAction>(serde_json::json!({
        "action": "list_tables",
        "params": {},
    }));
    assert!(rejected.is_err());
}
