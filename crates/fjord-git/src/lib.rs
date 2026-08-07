#![cfg_attr(test, allow(linker_messages))]

//! Git infrastructure wiring. Local repository behavior lives in [`local`]
//! and every network operation lives in [`remote`].

mod executable;
mod local;
mod locking;
pub mod remote;

pub use executable::GitCommandFactory;
pub use local::LocalGitBackend;
pub use remote::backend::SystemGitRemoteBackend;
pub use remote::environment::SystemGitEnvironmentProvider;
