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
    let pool = open_pool(db_path).await?;
    run_migrations(&pool, None).await?;
    Ok(pool)
}

/// Opens the pool without migrating. Split out so the migration tests can
/// build a database at an *older* schema version and then step forward,
/// which is the only way to prove a forward-only migration preserves rows
/// an existing install already has.
pub(crate) async fn open_pool(db_path: &Path) -> Result<SqlitePool, DbError> {
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true);

    // A `:memory:` database only exists for the lifetime of a single
    // connection — capping the pool at 1 here is what lets tests use
    // `connect(Path::new(":memory:"))` and reliably see their own writes,
    // instead of each pooled connection getting its own empty database.
    let max_connections = if db_path.as_os_str() == ":memory:" {
        1
    } else {
        5
    };

    SqlitePoolOptions::new()
        .max_connections(max_connections)
        .connect_with(options)
        .await
        .map_err(|e| DbError::Connect(e.to_string()))
}

/// Runs the embedded migrations, optionally stopping before `stop_before`.
/// `None` applies everything — the only behavior production uses.
pub(crate) async fn run_migrations(
    pool: &SqlitePool,
    stop_before: Option<i64>,
) -> Result<(), DbError> {
    let mut migrator = sqlx::migrate!("./migrations");
    if let Some(version) = stop_before {
        migrator.migrations = migrator
            .migrations
            .iter()
            .filter(|migration| migration.version < version)
            .cloned()
            .collect::<Vec<_>>()
            .into();
    }

    migrator
        .run(pool)
        .await
        .map_err(|e| DbError::Migrate(e.to_string()))
}
