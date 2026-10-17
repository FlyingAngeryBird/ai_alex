"""Deterministic reference prompt renderer; no network or model calls."""
from pathlib import Path
import hashlib, json, re, sys
from contract_schema_subset import load_json, require_valid

ROOT = Path(__file__).resolve().parents[1]
PLACEHOLDER = re.compile(r"\{\{([a-z_]+)\}\}")

def render_prompt(prompt_id, variables, root=ROOT):
    registry = load_json(root / "config/prompt-registry.json")
    entry = next((x for x in registry["entries"] if x["id"] == prompt_id), None)
    if entry is None:
        raise ValueError("Unknown prompt ID")
    if set(variables) != set(entry["variables"]):
        raise ValueError("Missing or unexpected prompt variables")
    text = (root / entry["path"]).read_text(encoding="utf-8")
    if set(PLACEHOLDER.findall(text)) != set(entry["variables"]):
        raise ValueError("Registry/template variable mismatch")
    for key, value in variables.items():
        schema_name = entry["variableSchemas"][key]
        require_valid(value, load_json(root / f"schemas/{schema_name}.schema.json"), key)
    # One pass over the template: braces inside user JSON are never re-expanded.
    return PLACEHOLDER.sub(lambda m: json.dumps(variables[m[1]], ensure_ascii=False, sort_keys=True, separators=(",", ":")), text)

def compose(mode, variables, root=ROOT):
    reg = load_json(root / "config/prompt-registry.json")
    parts = reg["composition"].get(mode)
    if parts is None:
        raise ValueError("Unknown composition")
    rendered = []
    expected = set()
    for key in parts:
        if key.startswith("PR"):
            entry = next(x for x in reg["entries"] if x["id"] == key)
            expected.update(entry["variables"])
            rendered.append(render_prompt(key, {k:variables[k] for k in entry["variables"]}, root))
        elif key == "SK01":
            rendered.append((root / "skills/companion-chat/SKILL.md").read_text(encoding="utf-8"))
        elif key == "app-context":
            expected.add("app_context")
            context = variables["app_context"]
            require_valid(context, load_json(root / "schemas/app-context.schema.json"), "app_context")
            if context["temporary"] and context["memories"]:
                raise ValueError("Temporary session contains long-term memory")
            rendered.append("APP_CONTEXT_DATA\n" + json.dumps(context, ensure_ascii=False, sort_keys=True))
        else:
            raise ValueError("Unknown composition component")
    if set(variables) != expected:
        raise ValueError("Missing or unexpected composition variables")
    compiled = "\n\n".join(rendered)
    return {"text": compiled, "sha256": hashlib.sha256(compiled.encode()).hexdigest()}

if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python3 scripts/render_prompts.py PR02 variables.json")
    result = render_prompt(sys.argv[1], load_json(sys.argv[2]))
    print(result)
