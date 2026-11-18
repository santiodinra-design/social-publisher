//! Prints what Publisher reads from a video file: `cargo run -p publisher-core --example probe -- <file>...`
fn main() {
	for arg in std::env::args().skip(1) {
		let path = std::path::Path::new(&arg);
		let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
		let started = std::time::Instant::now();
		let info = publisher_core::probe::probe(path, size, None);
		println!("{arg}\n  {info:?}\n  read in {:?}", started.elapsed());
	}
}
