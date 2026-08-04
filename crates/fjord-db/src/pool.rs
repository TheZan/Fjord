use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("failed to open database: {0}")]
    Connect(String),
    #[error("migration failed: {0}")]
    Migrate(String),
}

/// Opens (creating if needed) the SQLite database at `db_path` and runs
/// pending migrations. `db_path` is expected to be inside the app data dir
/// resolved by `fjord-app` — this crate has no opinion on where that is.
pub async fn connect(db_path: &Path) -> Result<SqlitePool, DbError> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true);

    // A `:memory:` database only exists for the lifetime of a single
    // connection — capping the pool at 1 here is what lets tests use
    // `connect(Path::new(":memory:"))` and reliably see their own writes,
    // instead of each pooled connection getting its own empty database.
    let max_connections = if db_path.as_os_str() == ":memory:" { 1 } else { 5 };

    let pool = SqlitePoolOptions::new()
        .max_connections(max_connections)
        .connect_with(options)
        .await
        .map_err(|e| DbError::Connect(e.to_string()))?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .map_err(|e| DbError::Migrate(e.to_string()))?;

    Ok(pool)
}
