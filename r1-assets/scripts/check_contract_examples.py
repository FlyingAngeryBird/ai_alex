"""Positive and negative contract examples; static, no model execution."""
from pathlib import Path
from contract_schema_subset import validate, load_json
from render_prompts import render_prompt

ROOT = Path(__file__).resolve().parents[1]
catalog = load_json(ROOT / "contracts/tool-catalog.json")
by_alias = {x["alias"]: x for x in catalog["businessTools"] + catalog["internalTools"]}
checks = 0
def case(alias, value, valid):
    global checks
    result = not validate(value, by_alias[alias]["input_schema"])
    assert result is valid, (alias, value, result)
    checks += 1
case("music_set_volume", {"expectedVersion":1,"volume":100}, True)
case("music_set_volume", {"expectedVersion":1,"volume":101}, False)
case("music_set_volume", {"expectedVersion":True,"volume":30}, False)
case("notes_create", {"type":"note","title":"方案","content":"原话","mode":"original","sourceRefs":["turn_1"]}, True)
case("notes_create", {"type":"note","title":"方案","content":"原话","mode":"original","sourceRefs":["turn_1"],"command":"execute"}, False)
case("notes_update", {"itemId":"item_1","expectedVersion":1,"patch":{}}, False)
case("notes_export", {"itemIds":["item_1"],"artifactId":None,"artifactVersion":None,"format":"md"}, True)
case("notes_export", {"itemIds":[],"artifactId":"artifact_1","artifactVersion":2,"format":"md"}, True)
case("notes_export", {"itemIds":["item_1"],"artifactId":"artifact_1","artifactVersion":2,"format":"md"}, False)
case("memory_forget", {"scope":"one","memoryId":"memory_1","expectedVersion":1}, True)
case("memory_forget", {"scope":"all_memories","memoryId":None,"expectedVersion":None}, True)
case("memory_forget", {"scope":"all_memories","memoryId":"memory_1","expectedVersion":1}, False)
case("music_queue", {"action":"clear","queueVersion":0,"trackKeys":[],"entryIds":[],"orderedEntryIds":[]}, True)
case("music_queue", {"action":"clear","queueVersion":0,"trackKeys":["track_1"],"entryIds":[],"orderedEntryIds":[]}, False)
case("focus_start", {"durationSec":59,"endMusicRule":"none"}, False)
case("focus_start", {"durationSec":1500,"endMusicRule":"none"}, True)
draft=load_json(ROOT / "evals/task-draft.valid.json")
assert not validate(draft, load_json(ROOT/"schemas/task-draft.schema.json"))
bad=dict(draft); bad["status"]="succeeded"
assert validate(bad, load_json(ROOT/"schemas/task-draft.schema.json"))
bad=dict(draft); bad["receiptActionIds"]=["new_id"]
# Schema checks shape; ID authenticity needs actual runtime registry and is NOT proven here.
assert not validate(bad, load_json(ROOT/"schemas/task-draft.schema.json"))
persona={"assistantName":"阿禾","userAddress":"","style":"字符串 {{task_input_json}} 不应二次展开","voiceId":"test_voice","version":1}
compiled=render_prompt("PR02",{"persona_json":persona})
assert "{{task_input_json}}" in compiled
try:
    render_prompt("PR02",{})
except ValueError:
    pass
else:
    raise AssertionError("Missing variable accepted")
try:
    render_prompt("PR02",{"persona_json":persona,"extra":"ignored"})
except ValueError:
    pass
else:
    raise AssertionError("Unexpected variable accepted")
print(f"PASS: {checks} positive/negative tool-input checks, TaskDraft shape and prompt-variable isolation. ID, authorization and state behavior require integration tests.")
