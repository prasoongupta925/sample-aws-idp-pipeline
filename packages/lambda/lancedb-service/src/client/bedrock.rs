//! Text embeddings with Amazon Titan Text Embeddings V2 on Bedrock.
//!
//! The model is EMBEDDING_MODEL_ID (the stack passes amazon.titan-embed-text-v2:0,
//! offered in-Region in ap-south-1); main.rs builds the client for EMBEDDING_REGION.
//! Vectors have 1024 dimensions and are normalized: the size of the LanceDB vector
//! column (db/model.rs VECTOR_DIMENSION). A table must only ever hold vectors of one
//! model, so a model change needs a re-index (deploy/lean/reindex.py).

use std::collections::hash_map::RandomState;
use std::future::Future;
use std::hash::{BuildHasher, Hasher};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aws_sdk_bedrockruntime::Client;
use aws_sdk_bedrockruntime::error::SdkError;
use aws_sdk_bedrockruntime::operation::invoke_model::InvokeModelError;
use aws_sdk_bedrockruntime::primitives::Blob;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Amazon Titan Text Embeddings V2 (AWS-sold, in-Region in ap-south-1).
pub const DEFAULT_MODEL_ID: &str = "amazon.titan-embed-text-v2:0";
/// Vector size of the LanceDB schema (db/model.rs VECTOR_DIMENSION).
pub const EMBEDDING_DIMENSION: usize = 1024;
/// Titan Text Embeddings V2 takes at most 50,000 characters (and 8,192 tokens).
pub const MAX_INPUT_CHARS: usize = 50_000;
/// An input Titan rejects as too long (over 8,192 tokens) is halved and sent
/// again, down to this length: the vector then covers the start of the text,
/// as with the END truncation of the previous model.
const MIN_SHORTENED_CHARS: usize = 2_000;

/// Retry schedule for throttled calls.
pub struct Backoff {
    /// Calls in total, the first one included.
    pub max_attempts: u32,
    /// Wait ceiling after the first failed call; it doubles after each one.
    pub base: Duration,
    /// Largest wait ceiling.
    pub cap: Duration,
}

/// Titan V2's on-demand quota is 60 requests a minute (not adjustable), shared
/// by the pipeline writers and every search: the waits add up to 30-60 s, about
/// one quota window, before the error goes back to the caller (the LanceDB
/// write queue then delivers the record again).
pub const THROTTLE_BACKOFF: Backoff = Backoff {
    max_attempts: 6,
    base: Duration::from_secs(2),
    cap: Duration::from_secs(30),
};

impl Backoff {
    /// Wait after failed call number `attempt` (1-based): half of
    /// min(cap, base * 2^(attempt - 1)) plus `jitter` (0..=1) of the other half,
    /// so concurrent writers do not retry in step.
    pub fn delay(&self, attempt: u32, jitter: f64) -> Duration {
        let doublings = attempt.saturating_sub(1).min(16);
        let ceiling = self.base.saturating_mul(1 << doublings).min(self.cap);
        ceiling / 2 + ceiling.mul_f64(jitter.clamp(0.0, 1.0)) / 2
    }
}

/// A random fraction in 0..1 (std only: RandomState keys differ per instance).
fn jitter() -> f64 {
    let mut hasher = RandomState::new().build_hasher();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    hasher.write_u128(nanos);
    (hasher.finish() >> 11) as f64 / (1u64 << 53) as f64
}

/// Runs `call` until it succeeds, fails with an error `retryable` rejects, or
/// `backoff.max_attempts` calls are used; returns the last result.
pub async fn retry_with_backoff<T, E, F, Fut>(
    backoff: &Backoff,
    retryable: impl Fn(&E) -> bool,
    mut call: F,
) -> Result<T, E>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let mut attempt = 1;
    loop {
        match call().await {
            Err(err) if attempt < backoff.max_attempts && retryable(&err) => {
                let wait = backoff.delay(attempt, jitter());
                warn!(
                    "[generate_embedding] Throttled (call {attempt} of {}), retrying in {} ms",
                    backoff.max_attempts,
                    wait.as_millis()
                );
                tokio::time::sleep(wait).await;
                attempt += 1;
            }
            result => return result,
        }
    }
}

/// Errors that mean "slow down and try again".
pub fn is_throttle_error(err: &InvokeModelError) -> bool {
    err.is_throttling_exception() || err.is_service_unavailable_exception()
}

fn is_throttled(err: &SdkError<InvokeModelError>) -> bool {
    err.as_service_error().is_some_and(is_throttle_error)
}

fn is_validation(err: &SdkError<InvokeModelError>) -> bool {
    err.as_service_error()
        .is_some_and(InvokeModelError::is_validation_exception)
}

/// The model id: EMBEDDING_MODEL_ID when set (and not blank), else the default.
pub fn model_id_from(value: Option<String>) -> String {
    value
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL_ID.to_string())
}

fn model_id() -> String {
    model_id_from(std::env::var("EMBEDDING_MODEL_ID").ok())
}

/// The first `max_chars` characters of `text` (all of it when shorter).
pub fn truncate_chars(text: &str, max_chars: usize) -> &str {
    match text.char_indices().nth(max_chars) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    #[serde(rename = "inputText")]
    input_text: &'a str,
    dimensions: usize,
    normalize: bool,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    embedding: Vec<f32>,
}

/// Titan Text Embeddings V2 request body.
pub fn request_body(input: &str) -> Result<Vec<u8>, BoxError> {
    Ok(serde_json::to_vec(&EmbeddingRequest {
        input_text: input,
        dimensions: EMBEDDING_DIMENSION,
        normalize: true,
    })?)
}

/// The vector of a Titan Text Embeddings V2 response; an error for any other
/// shape or size, so a wrong model never writes into a table.
pub fn parse_embedding(body: &[u8]) -> Result<Vec<f32>, BoxError> {
    let response: EmbeddingResponse = serde_json::from_slice(body).map_err(|e| {
        format!("unexpected embedding response (not Titan Text Embeddings V2): {e}")
    })?;
    if response.embedding.len() != EMBEDDING_DIMENSION {
        return Err(format!(
            "embedding has {} dimensions, the LanceDB schema needs {EMBEDDING_DIMENSION}",
            response.embedding.len()
        )
        .into());
    }
    Ok(response.embedding)
}

pub async fn generate_embedding(client: &Client, text: &str) -> Result<Vec<f32>, BoxError> {
    let value = text.trim();
    if value.is_empty() {
        return Ok(vec![0.0; EMBEDDING_DIMENSION]);
    }

    let model_id = model_id();
    let mut input = truncate_chars(value, MAX_INPUT_CHARS);
    info!(
        "[generate_embedding] Invoking {model_id}, text length: {}",
        input.len()
    );

    loop {
        let body = request_body(input)?;
        let result = retry_with_backoff(&THROTTLE_BACKOFF, is_throttled, || {
            client
                .invoke_model()
                .model_id(&model_id)
                .content_type("application/json")
                .accept("application/json")
                .body(Blob::new(body.clone()))
                .send()
        })
        .await;

        match result {
            Ok(response) => {
                let embedding = parse_embedding(response.body().as_ref())?;
                info!(
                    "[generate_embedding] Got embedding with {} dimensions",
                    embedding.len()
                );
                return Ok(embedding);
            }
            Err(err) if is_validation(&err) && input.chars().count() > MIN_SHORTENED_CHARS => {
                let shorter = truncate_chars(input, input.chars().count() / 2);
                warn!(
                    "[generate_embedding] Input rejected ({}), retrying with its first {} characters",
                    aws_sdk_bedrockruntime::Error::from(err),
                    shorter.chars().count()
                );
                input = shorter;
            }
            Err(err) => return Err(Box::new(aws_sdk_bedrockruntime::Error::from(err))),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use aws_sdk_bedrockruntime::types::error::{ThrottlingException, ValidationException};

    use super::*;

    #[test]
    fn request_body_is_titan_v2() {
        let body: serde_json::Value =
            serde_json::from_slice(&request_body("net pay").unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"inputText": "net pay", "dimensions": 1024, "normalize": true})
        );
    }

    #[test]
    fn parses_a_titan_v2_response() {
        let body = serde_json::json!({
            "embedding": vec![0.5_f32; EMBEDDING_DIMENSION],
            "inputTextTokenCount": 3,
            "embeddingsByType": {"float": vec![0.5_f32; EMBEDDING_DIMENSION]},
        });
        let embedding = parse_embedding(&serde_json::to_vec(&body).unwrap()).unwrap();
        assert_eq!(embedding.len(), EMBEDDING_DIMENSION);
    }

    #[test]
    fn rejects_other_response_shapes_and_sizes() {
        // Nova multimodal embeddings answer {"embeddings": [{"embedding": [...]}]}.
        let nova =
            serde_json::json!({"embeddings": [{"embedding": vec![0.5_f32; EMBEDDING_DIMENSION]}]});
        let err = parse_embedding(&serde_json::to_vec(&nova).unwrap()).unwrap_err();
        assert!(
            err.to_string().contains("not Titan Text Embeddings V2"),
            "{err}"
        );

        let small = serde_json::json!({"embedding": vec![0.5_f32; 512]});
        let err = parse_embedding(&serde_json::to_vec(&small).unwrap()).unwrap_err();
        assert!(err.to_string().contains("512 dimensions"), "{err}");
    }

    #[test]
    fn model_id_comes_from_the_environment_value() {
        assert_eq!(model_id_from(None), DEFAULT_MODEL_ID);
        assert_eq!(model_id_from(Some("  ".into())), DEFAULT_MODEL_ID);
        assert_eq!(
            model_id_from(Some(" amazon.titan-embed-text-v2:0 ".into())),
            "amazon.titan-embed-text-v2:0"
        );
    }

    #[test]
    fn truncates_on_character_boundaries() {
        assert_eq!(truncate_chars("salary", 50), "salary");
        assert_eq!(truncate_chars("salary", 3), "sal");
        // Devanagari: 3 bytes per character.
        assert_eq!(truncate_chars("पगार किती", 4), "पगार");
    }

    #[test]
    fn backoff_doubles_up_to_the_cap() {
        let b = &THROTTLE_BACKOFF;
        assert_eq!(b.delay(1, 0.0), Duration::from_secs(1));
        assert_eq!(b.delay(1, 1.0), Duration::from_secs(2));
        assert_eq!(b.delay(2, 1.0), Duration::from_secs(4));
        assert_eq!(b.delay(4, 1.0), Duration::from_secs(16));
        assert_eq!(b.delay(5, 0.0), Duration::from_secs(15));
        assert_eq!(b.delay(5, 1.0), Duration::from_secs(30));
        assert_eq!(b.delay(40, 1.0), Duration::from_secs(30));
        // Retries alone wait at least 30 s (about one quota window) and at most 60 s.
        let least: Duration = (1..b.max_attempts).map(|a| b.delay(a, 0.0)).sum();
        let most: Duration = (1..b.max_attempts).map(|a| b.delay(a, 1.0)).sum();
        assert_eq!(
            (least, most),
            (Duration::from_secs(30), Duration::from_secs(60))
        );
    }

    #[test]
    fn throttling_and_unavailable_are_retried_validation_is_not() {
        let throttled = InvokeModelError::ThrottlingException(
            ThrottlingException::builder()
                .message("Too many requests")
                .build(),
        );
        let invalid = InvokeModelError::ValidationException(
            ValidationException::builder()
                .message("Malformed input request")
                .build(),
        );
        assert!(is_throttle_error(&throttled));
        assert!(!is_throttle_error(&invalid));
    }

    const FAST: Backoff = Backoff {
        max_attempts: 4,
        base: Duration::from_millis(1),
        cap: Duration::from_millis(2),
    };

    #[tokio::test]
    async fn retries_a_throttled_call_until_it_succeeds() {
        let calls = Cell::new(0);
        let result: Result<&str, &str> = retry_with_backoff(
            &FAST,
            |e| *e == "throttled",
            || {
                calls.set(calls.get() + 1);
                let n = calls.get();
                async move {
                    if n < 3 {
                        Err("throttled")
                    } else {
                        Ok("vector")
                    }
                }
            },
        )
        .await;
        assert_eq!(result, Ok("vector"));
        assert_eq!(calls.get(), 3);
    }

    #[tokio::test]
    async fn gives_up_after_max_attempts() {
        let calls = Cell::new(0);
        let result: Result<(), &str> = retry_with_backoff(
            &FAST,
            |_| true,
            || {
                calls.set(calls.get() + 1);
                async { Err("throttled") }
            },
        )
        .await;
        assert_eq!(result, Err("throttled"));
        assert_eq!(calls.get(), FAST.max_attempts);
    }

    #[tokio::test]
    async fn other_errors_are_not_retried() {
        let calls = Cell::new(0);
        let result: Result<(), &str> = retry_with_backoff(
            &FAST,
            |e| *e == "throttled",
            || {
                calls.set(calls.get() + 1);
                async { Err("access denied") }
            },
        )
        .await;
        assert_eq!(result, Err("access denied"));
        assert_eq!(calls.get(), 1);
    }
}
