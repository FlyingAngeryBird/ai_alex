"""Static validator for the Draft-7 subset used by this asset package.
Not a replacement for a production JSON Schema library.
"""
from pathlib import Path
import json, math

SUPPORTED = {"$schema", "title", "description", "type", "properties", "required",
             "additionalProperties", "items", "maxItems", "minItems", "maxLength",
             "minLength", "minProperties", "enum", "minimum", "maximum", "const", "oneOf", "anyOf"}

def lint(schema, path="$"):
    if not isinstance(schema, dict):
        raise ValueError(f"{path}: schema must be an object")
    unknown = set(schema) - SUPPORTED
    if unknown:
        raise ValueError(f"{path}: unsupported validation keywords {sorted(unknown)}")
    for key in ("anyOf", "oneOf"):
        for i, sub in enumerate(schema.get(key, [])):
            lint(sub, f"{path}.{key}[{i}]")
    for key, sub in schema.get("properties", {}).items():
        lint(sub, f"{path}.{key}")
    if "items" in schema:
        lint(schema["items"], path + "[]")
    if isinstance(schema.get("additionalProperties"), dict):
        lint(schema["additionalProperties"], path + ".*")
    if set(schema.get("required", [])) - set(schema.get("properties", {})):
        raise ValueError(f"{path}: required key has no property schema")

def validate(value, schema, path="$"):
    errors = []
    for keyword, condition in (("anyOf", lambda n: n >= 1), ("oneOf", lambda n: n == 1)):
        if keyword in schema:
            count = sum(not validate(value, sub, path) for sub in schema[keyword])
            if not condition(count):
                errors.append(f"{path}: {keyword} does not match")
    if "const" in schema and (type(value) is not type(schema["const"]) or value != schema["const"]):
        errors.append(f"{path}: incorrect const")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: value outside enum")
    typ = schema.get("type")
    checks = {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "boolean": isinstance(value, bool),
        "null": value is None,
        "integer": isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value == int(value),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value),
    }
    if typ and not checks.get(typ, False):
        return errors + [f"{path}: expected {typ}"]
    if isinstance(value, dict):
        if len(value) < schema.get("minProperties", 0):
            errors.append(f"{path}: object property count")
        props = schema.get("properties", {})
        for k in schema.get("required", []):
            if k not in value:
                errors.append(f"{path}.{k}: missing")
        for k, v in value.items():
            if k in props:
                errors.extend(validate(v, props[k], f"{path}.{k}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}.{k}: unexpected")
            elif isinstance(schema.get("additionalProperties"), dict):
                errors.extend(validate(v, schema["additionalProperties"], f"{path}.{k}"))
    if isinstance(value, list):
        if len(value) > schema.get("maxItems", float("inf")) or len(value) < schema.get("minItems", 0):
            errors.append(f"{path}: array length")
        if "items" in schema:
            for i, v in enumerate(value):
                errors.extend(validate(v, schema["items"], f"{path}[{i}]"))
    if isinstance(value, str):
        if len(value) > schema.get("maxLength", float("inf")) or len(value) < schema.get("minLength", 0):
            errors.append(f"{path}: string length")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value < schema.get("minimum", -float("inf")) or value > schema.get("maximum", float("inf")):
            errors.append(f"{path}: numeric bounds")
    return errors

def require_valid(value, schema, label):
    errors = validate(value, schema)
    if errors:
        raise ValueError(label + ": " + "; ".join(errors))

def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))
