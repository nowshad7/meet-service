#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

CONTRACT = Path(__file__).resolve().parent.parent / "contract"
SCHEMA_FOR_EXAMPLE = {
    "room-gate-conflict": "room-gate-response",
    "room-gate-denied": "room-gate-response",
}


def load_schemas():
    schemas = {path.name: json.loads(path.read_text()) for path in (CONTRACT / "schemas").glob("*.json")}
    registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas.values()
    )
    return schemas, registry


def validate(schemas, registry, name, payload, source):
    schema_name = SCHEMA_FOR_EXAMPLE.get(name, name) + ".schema.json"
    validator = Draft202012Validator(schemas[schema_name], registry=registry)
    errors = [error.message for error in validator.iter_errors(payload)]
    for message in errors:
        print(f"FAIL {source}: {message}")
    return len(errors)


def main():
    schemas, registry = load_schemas()
    for schema in schemas.values():
        Draft202012Validator.check_schema(schema)

    examples = sorted((CONTRACT / "examples").glob("*.json"))
    failures = sum(
        validate(schemas, registry, example.stem, json.loads(example.read_text()), example.name)
        for example in examples
    )
    print(f"contract: {len(examples)} examples checked")

    if len(sys.argv) > 1:
        samples = json.loads(Path(sys.argv[1]).read_text())
        failures += sum(
            validate(schemas, registry, name, payload, f"reference app {name}")
            for name, payload in samples.items()
        )
        print(f"contract: {len(samples)} reference app payloads checked")

    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
