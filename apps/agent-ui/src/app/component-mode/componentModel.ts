import type {
  Component,
  ConfigFieldBaseType,
  ConfigFieldType,
  ConfigSchemaItem,
  GenericComponentConfig,
  ParameterDef,
  ParameterSchema,
  PortDef,
} from "../../types";

// dataTransfer key used when dragging a *registered* component from the sidebar
// onto the canvas (vs. the old "create on drop" generic key).
export const COMPONENT_DRAG_KEY = "application/claw-component";

// dataTransfer key used when dragging the *generic* "generic component" item from the
// sidebar onto the canvas. The handler creates a fresh, non-global component
// row (global=false) on drop — this is the default, everyday path.
export const GENERIC_DRAG_KEY = "application/claw-generic";

// The component's IO ports live in `inputSchema`/`outputSchema` as a JSON
// schema (`{type:"object", properties:{name: {type, format}}}`). The form UI
// works with a simpler `PortDef[]` model, so we bridge the two here.

export function schemaToPorts(schema?: ParameterSchema | null): PortDef[] {
  if (!schema || !schema.properties) return [];
  return Object.entries(schema.properties).map(([name, def]) => {
    // A status (control-flow) port is encoded as {type:"status"}. Everything
    // else is a file (data) port encoded as {type:"string", format:<fmt>}; the
    // `format` sub-property carries the file type (parquet / csv / json / …),
    // "file" or missing ⇒ any file.
    if (def.type === "status") {
      return {name, type: "status"};
    }
    const rawFmt = typeof def.format === "string" ? def.format : undefined;
    const format = rawFmt && rawFmt !== "file" ? rawFmt : undefined;
    return {name, type: "file", format};
  });
}

export function portsToSchema(ports: PortDef[]): ParameterSchema {
  const properties: Record<string, ParameterDef> = {};
  for (const port of ports) {
    const name = port.name.trim();
    if (name === "") continue;
    // Status ports carry no data ⇒ {type:"status"}. File ports keep the
    // JSON-schema shape {type:"string", format:<fmt>} the backend already stores.
    properties[name] =
      port.type === "status"
        ? {type: "status"}
        : {type: "string", format: port.format ?? "file"};
  }
  return {type: "object", properties};
}

// Parse a component's git/IO definition into the form's UI model. Free-form
// instance parameters live in `node.config.params` (edited by InstanceConfigForm),
// so this bridge only carries the component *definition* (git / IO / schema).
export function componentToConfig(component: Component): GenericComponentConfig {
  return {
    name: component.name,
    inputs: schemaToPorts(component.inputSchema),
    outputs: schemaToPorts(component.outputSchema),
    gitUrl: component.gitUrl,
    gitBranch: component.gitBranch,
    gitRef: component.gitRef,
    params: {},
    entryPoint: component.entryPoint,
    configSchema: parseConfigSchema(component.configSchema),
  };
}

// Normalize a raw config_schema value (from the backend JSON string / object)
// into a typed `ConfigSchemaItem[]`. Tolerates null/undefined and malformed
// entries so the UI never crashes on legacy or partially-written data.
export function parseConfigSchema(raw: unknown): ConfigSchemaItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfigSchemaItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const key = typeof obj.key === "string" ? obj.key : "";
    const label = typeof obj.label === "string" ? obj.label : key;
    const type = normalizeSchemaType(obj.type);
    const required = obj.required === true;
    const enumValues = Array.isArray(obj.enum)
      ? (obj.enum as unknown[]).filter((v): v is string => typeof v === "string")
      : undefined;
    out.push({
      key,
      label,
      type,
      required,
      default: obj.default,
      enum: enumValues,
      description: typeof obj.description === "string" ? obj.description : undefined,
    });
  }
  return out;
}

// A `list` parameter is stored as `{kind:"list", element:<base>}`; everything
// else is a plain base-type string. Normalize either shape into a common form.
export function normalizeSchemaType(type: unknown): ConfigFieldType {
  if (
    type &&
    typeof type === "object" &&
    (type as Record<string, unknown>).kind === "list"
  ) {
    const element = (type as Record<string, unknown>).element;
    const base = (typeof element === "string" ? element : "string") as ConfigFieldBaseType;
    return {kind: "list", element: base};
  }
  const base = (typeof type === "string" ? type : "string") as ConfigFieldBaseType;
  return base;
}

export function isListType(type: ConfigFieldType): type is {kind: "list"; element: ConfigFieldBaseType} {
  return typeof type === "object" && type.kind === "list";
}

// Build a `ConfigFieldType` from the editor's dropdown selection. When the base
// is "list", `element` (also a dropdown) supplies the element type.
export function buildSchemaType(
  base: ConfigFieldBaseType | "list",
  element: ConfigFieldBaseType,
): ConfigFieldType {
  if (base === "list") return {kind: "list", element};
  return base;
}

// Build an updated component from the form UI model (definition-level fields
// only: name / git / IO / schema). Instance parameters are stored separately
// in `node.config.params` by InstanceConfigForm.
export function configToComponent(base: Component, cfg: GenericComponentConfig): Component {
  return {
    ...base,
    name: cfg.name.trim() || "未命名组件",
    gitUrl: cfg.gitUrl.trim(),
    gitBranch: cfg.gitBranch.trim(),
    gitRef: cfg.gitRef.trim(),
    entryPoint: cfg.entryPoint.trim(),
    inputSchema: portsToSchema(cfg.inputs),
    outputSchema: portsToSchema(cfg.outputs),
    configSchema: cfg.configSchema,
    updatedAtMs: Date.now(),
  };
}

// ─── Register-component form (right-hand panel) ────────────────────────────

export type RegisterComponentInput = {
  name: string;
  description: string;
  gitUrl: string;
  gitBranch: string;
  gitRef: string;
  entryPoint: string;
  // Parameter declarations for this reusable component. Editing config_schema
  // is a registration-time concern (schema ⇒ global/registered component).
  configSchema: ConfigSchemaItem[];
  // IO port declarations (key + type). Serialized into input_schema /
  // output_schema via portsToSchema at assembly time.
  inputPorts: PortDef[];
  outputPorts: PortDef[];
};

// A freshly registered component is always `global=true` — that is what makes
// it appear in the sidebar list and be reusable across DAGs.
export function assembleRegisterComponent(
  input: RegisterComponentInput,
  id: string,
  nowMs: number,
): Component {
  return {
    id,
    name: input.name.trim(),
    description: input.description.trim(),
    status: "draft",
    workspaceRoot: "",
    gitUrl: input.gitUrl.trim(),
    gitBranch: input.gitBranch.trim(),
    gitRef: input.gitRef.trim(),
    entryPoint: input.entryPoint.trim(),
    inputSchema: portsToSchema(input.inputPorts),
    outputSchema: portsToSchema(input.outputPorts),
    configSchema: input.configSchema,
    tags: [],
    global: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

// Edit mode: rebuild a component from the form, but **preserve the identity and
// lifecycle fields** of the existing row (`id` / `status` / `createdAtMs` /
// `global` / `tags` / `workspaceRoot`) so the update writes back to the SAME
// `component_id` and all canvas references keep pointing at it. Only the
// definition-level fields (name / git / IO / schema) and `updatedAtMs` change.
export function assembleUpdateComponent(
  input: RegisterComponentInput,
  base: Component,
  nowMs: number,
): Component {
  return {
    ...base,
    name: input.name.trim(),
    description: input.description.trim(),
    gitUrl: input.gitUrl.trim(),
    gitBranch: input.gitBranch.trim(),
    gitRef: input.gitRef.trim(),
    entryPoint: input.entryPoint.trim(),
    inputSchema: portsToSchema(input.inputPorts),
    outputSchema: portsToSchema(input.outputPorts),
    configSchema: input.configSchema,
    updatedAtMs: nowMs,
  };
}

// The only required field is a non-blank name; everything else has a sensible
// default (git/branch/ref/entryPoint can be filled later in the config tab).
export function canSubmitRegister(input: RegisterComponentInput): boolean {
  return input.name.trim() !== "";
}

// ─── Validation ────────────────────────────────────────────────────────────

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

// Validate one instance value against a single schema item. Returns an error
// string, or null if valid. Drives the red `*` + inline error UI in the
// instance form, and the run/publish gate.
export function validateInstanceValue(
  item: ConfigSchemaItem,
  value: unknown,
): string | null {
  if (item.required && isEmptyValue(value)) {
    return "必填";
  }
  if (isEmptyValue(value)) {
    return null; // optional + empty => ok
  }
  const list = isListType(item.type) ? item.type : null;
  if (list) {
    if (!Array.isArray(value)) return "应为列表";
    for (const el of value) {
      const err = validateScalar(list.element, el, item.enum);
      if (err) return err;
    }
    return null;
  }
  return validateScalar(item.type as ConfigFieldBaseType, value, item.enum);
}

function validateScalar(
  base: ConfigFieldBaseType,
  value: unknown,
  enumOptions: string[] | undefined,
): string | null {
  switch (base) {
    case "number":
      if (typeof value === "number") return null;
      if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
        return null;
      }
      return "应为数字";
    case "boolean":
      return typeof value === "boolean" ? null : "应为布尔";
    case "enum":
      if (typeof value !== "string") return "应为枚举值";
      if (enumOptions && enumOptions.length > 0 && !enumOptions.includes(value)) {
        return "不在可选范围";
      }
      return null;
    case "string":
    case "path":
    case "date":
      return typeof value === "string" ? null : "应为文本";
    default:
      return null;
  }
}

// Validate the entire instance config (a `node.config.params` map) against the
// component's schema. Returns a map of `key -> error message` for the invalid
// entries only (empty map = all good).
export function validateInstanceConfig(
  schema: ConfigSchemaItem[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const item of schema) {
    const err = validateInstanceValue(item, values[item.key]);
    if (err) errors[item.key] = err;
  }
  return errors;
}

// Validate the schema *declaration* itself (definition-level editor). Guards
// against empty / duplicate keys and enum items without options.
export function validateConfigSchemaDef(
  items: ConfigSchemaItem[],
): Record<number, string> {
  const errors: Record<number, string> = {};
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const key = item.key.trim();
    if (key === "") {
      errors[i] = "key 不能为空";
      return;
    }
    if (seen.has(key)) {
      errors[i] = "key 重复";
      return;
    }
    seen.add(key);
    if (item.type === "enum" && (!item.enum || item.enum.length === 0)) {
      errors[i] = "enum 需选项";
    }
  });
  return errors;
}
