fn main() {
    #[cfg(feature = "gui")]
    {
        use tauri_build;
        tauri_build::build();
    }
}
