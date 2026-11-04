use std::path::Path;

fn main() {
    // Tauri embeds the frontend into the binary at compile time, but its build
    // script only tracks `tauri.conf.json` — not the files it points at. Without
    // the watch below, editing the frontend and running `cargo build` is a no-op:
    // cargo sees no changed inputs, keeps the old binary, and the app launches with
    // the *previous* bundle (or an empty page if the asset hashes no longer match).
    //
    // Registering the dist directory's mtime as an input makes any frontend rebuild
    // invalidate this crate.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let dist = Path::new(&manifest_dir).join("../../app/dist");

    println!("cargo:rerun-if-changed={}", dist.display());
    if let Ok(entries) = std::fs::read_dir(dist.join("assets")) {
        println!("cargo:rerun-if-changed={}", dist.join("assets").display());
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .collect();
        names.sort();
        for name in names {
            println!("cargo:rerun-if-changed={}", dist.join("assets").join(name).display());
        }
    }
    println!("cargo:rerun-if-changed={}", dist.join("index.html").display());

    tauri_build::build()
}
