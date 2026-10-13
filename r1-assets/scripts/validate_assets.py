"""Validate release assets, references, tool scopes and prompt compilation."""
from pathlib import Path
import hashlib, json, re
from contract_schema_subset import lint, load_json
from render_prompts import PLACEHOLDER

ROOT = Path(__file__).resolve().parents[1]
prompts = load_json(ROOT / "config/prompt-registry.json")
skills = load_json(ROOT / "config/skill-registry.json")
catalog = load_json(ROOT / "contracts/tool-catalog.json")
config = load_json(ROOT / "config/runtime.defaults.json")
assert len(prompts["entries"]) == 10
assert len(skills["entries"]) == 6
assert len(catalog["businessTools"]) == 38
assert len(catalog["internalTools"]) == 3
aliases = [t["alias"] for t in catalog["businessTools"] + catalog["internalTools"]]
names = [t["name"] for t in catalog["businessTools"] + catalog["internalTools"]]
assert len(aliases) == len(set(aliases)) == len(set(names))
assert all(re.fullmatch(r"[a-z][a-z0-9_]*", x) for x in aliases)
for t in catalog["businessTools"] + catalog["internalTools"]:
    lint(t["input_schema"])
    lint(t["output_data_schema"])
    assert (ROOT / t["output_schema"]).is_file()
for p in prompts["entries"]:
    text = (ROOT / p["path"]).read_text()
    assert set(PLACEHOLDER.findall(text)) == set(p["variables"]), p["id"]
    assert all((ROOT / f"schemas/{s}.schema.json").is_file() for s in p["variableSchemas"].values())
for sk in skills["entries"]:
    path = ROOT / sk["path"]
    text = path.read_text()
    header = text.split("---", 2)[1]
    assert f"name: {sk['name']}" in header
    assert "description:" in header
    assert path.parent.name == sk["name"]
    assert len(text.splitlines()) < 500
    assert len(sk["allowedTools"]) == len(set(sk["allowedTools"]))
    assert all(x in names for x in sk["allowedTools"])
    for relative in re.findall(r"\]\((references/[^)]+)\)", text):
        assert (path.parent / relative).is_file()
for schema in (ROOT / "schemas").glob("*.json"):
    lint(load_json(schema))
assert config["providerPolicy"]["primary"] == "volcengine"
assert config["providerPolicy"]["crossProviderFallback"] is False
assert config["providerPolicy"]["taskResponseStore"] is False
assert config["harness"]["generalPurposeSubagent"] is False
assert set(config["harness"]["excludedTools"]) & set(aliases) == set()
assert all(a in aliases for group in config["activation"].values() if isinstance(group, list) for a in group if not a.startswith("SK"))
manifest = load_json(ROOT / "asset-manifest.json")
for f in manifest["files"]:
    path = ROOT / f["path"]
    assert path.is_file(), f["path"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == f["sha256"], f["path"]
actual = {str(p.relative_to(ROOT)) for p in ROOT.rglob("*") if p.is_file() and ".git" not in p.parts and "__pycache__" not in p.parts and p.name != "asset-manifest.json"}
assert actual == {f["path"] for f in manifest["files"]}, "Manifest file set differs"
cases = [json.loads(l) for l in (ROOT / "evals/behavior-cases.jsonl").read_text().splitlines()]
assert {c["id"] for c in cases} == {f"E{i:02}" for i in range(1,17)}
print(f"PASS: 10 prompts, 6 skills, 38 business tools, 3 internal tools, {len(list((ROOT/'schemas').glob('*.json')))} schemas, 16 behavior fixtures, {len(manifest['files'])} hashed files")
