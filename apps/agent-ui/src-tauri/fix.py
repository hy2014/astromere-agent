with open('../../../rust/crates/rusty-claude-cli/src/live_cli/mod.rs', 'r') as f:
    c = f.read()

new_method = '''    pub fn new_with_workspace(
        workspace: std::path::PathBuf,
        model: String,
        enable_tools: bool,
        allowed_tools: Option<AllowedToolSet>,
        permission_mode: PermissionMode,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let system_prompt = build_system_prompt()?;
        let session_state = Session::new().with_workspace_root(workspace);
        let session = create_managed_session_handle(&session_state.session_id)?;
        let runtime = build_runtime(
            session_state.with_persistence_path(session.path.clone()),
            &session.id,
            model.clone(),
            system_prompt.clone(),
            enable_tools,
            true,
            allowed_tools.clone(),
            permission_mode,
            None,
        )?;
        let cli = Self {
            model,
            allowed_tools,
            permission_mode,
            system_prompt,
            runtime,
            session,
            prompt_history: Vec::new(),
        };
        cli.persist_session()?;
        Ok(cli)
    }

    pub fn set_reasoning_effort'''

# 插在 new() 和 set_reasoning_effort 之间
old = 'cli.persist_session()?;\n        Ok(cli)\n    }\n\n    pub fn set_reasoning_effort'
new = 'cli.persist_session()?;\n        Ok(cli)\n    }\n' + new_method
c = c.replace(old, new)

with open('../../../rust/crates/rusty-claude-cli/src/live_cli/mod.rs', 'w') as f:
    f.write(c)
print("Fixed")
