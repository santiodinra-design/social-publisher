//! Publisher backend in Rust: the local API, the persistent job queue, the publishing worker and the
//! platform adapters. It is a port of `server/` and keeps the same database schema, token format and
//! HTTP contract, so the React UI in `src/` runs against it unchanged.

// Handlers return ready-made HTTP responses as their error type, which is large by design.
#![allow(clippy::result_large_err, clippy::type_complexity)]

pub mod accounts;
pub mod analytics;
pub mod app;
pub mod covers;
pub mod crypto;
pub mod db;
pub mod groups;
pub mod inbox;
pub mod jobs;
pub mod keys;
pub mod logging;
pub mod media;
pub mod notify;
pub mod phone;
pub mod platforms;
pub mod probe;
pub mod relay;
pub mod runner;
pub mod server;
pub mod settings;
pub mod util;

pub use app::{App, Config, Endpoints, Notice, Shell};
