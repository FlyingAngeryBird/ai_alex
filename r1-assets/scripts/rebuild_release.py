"""Rebuild generated PRD and deterministic asset hashes from canonical sources."""
from pathlib import Path
import hashlib, json, re

ROOT = Path(__file__).resolve().parents[1]
FENCE = chr(96) * 3
def text(path):
    return (ROOT/path).read_text(encoding="utf-8")
def data(path):
    return json.loads(text(path))
def cell(value):
    return str(value).replace("|", "\\|").replace("\n", " ")
def embed(path):
    return re.sub(r"^(#{1,5}) ", lambda m: "##"+m[1]+" ", text(path), flags=re.M)
def render_appendix():
    editorial=text("docs/DETAIL_SPEC.md")
    section=lambda n:re.search(rf"^## {n} [\s\S]*?(?=^## {n+1} |\Z)",editorial,re.M).group(0).rstrip()
    out=["## 21 当前方案审查与开发就绪决定",embed("docs/AUDIT.md"),section(22)]
    reg=data("config/prompt-registry.json")
    lines=["### 22.3 Prompt注册表","","| 编号 | 文件 | 模型角色 | 变量Schema |","| --- | --- | --- | --- |"]
    for p in reg["entries"]:
        v=", ".join(k+"→"+s for k,s in p["variableSchemas"].items()) or "无动态变量"
        lines.append(f"| {p['id']} | {p['path']} | {','.join(p['modelRoles'])} | {cell(v)} |")
    out.append("\n".join(lines))
    for p in reg["entries"]:
        out.append(f"### 22.4.{p['id'][2:]} {p['id']} {p['description']}\n\n实际文件：{p['path']}，版本{p['version']}。\n\n"+FENCE+"text\n"+text(p["path"]).rstrip()+"\n"+FENCE)
    out.append(section(23))
    skreg=data("config/skill-registry.json")
    lines=["### 23.2 实际Skill目录与范围","","| Skill | 标准目录名 | 逻辑别名 | 允许工具 |","| --- | --- | --- | --- |"]
    for sk in skreg["entries"]:
        lines.append(f"| {sk['skillId']} | {sk['name']} | {sk['legacyKey']} | {cell(', '.join(sk['allowedTools']))} |")
    out.append("\n".join(lines))
    for sk in skreg["entries"]:
        out.append(f"### 23.3.{sk['skillId'][2:]} {sk['skillId']} 完整SKILL.md\n\n"+"~~~markdown\n"+text(sk["path"]).rstrip()+"\n~~~\n\n"+f"声明参考文件：{sk['resourcePaths'][0]}\n\n~~~markdown\n"+text(sk["resourcePaths"][0]).rstrip()+"\n~~~")
    out.append(section(24))
    catalog=data("contracts/tool-catalog.json")
    lines=["### 24.4 独立工具的参数与返回合同","","完整嵌套字段、互斥条件及长度限制以同包tool-catalog.json为准。下表展开所有操作，不省略某个默认工具。","","| 内部操作 | 模型别名 | 输入字段 | 成功data字段 | 作用 |","| --- | --- | --- | --- | --- |"]
    for t in catalog["businessTools"]+catalog["internalTools"]:
        req=set(t["input_schema"]["required"])
        fields=", ".join(k+("＊" if k in req else "") for k in t["input_schema"]["properties"]) or "无"
        returns=", ".join(t["output_data_schema"]["properties"])
        lines.append(f"| {t['name']} | {t['alias']} | {cell(fields)} | {cell(returns)} | {t['effect']} |")
    out.append("\n".join(lines))
    out.append("＊表示模型参数必填；程序生成的版本/授权/幂等等字段不在模型参数中。相互依赖的工具按依赖串行，成功data须使用该操作对应Schema。")
    out.append("### 24.5 核心结构化输出正文")
    for name in ["task-draft","memory-candidates","context-summary","tool-output"]:
        out.append(f"实际文件：schemas/{name}.schema.json\n\n"+FENCE+"json\n"+text(f"schemas/{name}.schema.json").rstrip()+"\n"+FENCE)
    out.append(section(25))
    out.append("### 25.2 发布与迭代规则\n\n"+embed("docs/CHANGE_POLICY.md"))
    out.append("### 25.3 完整默认配置\n\n"+FENCE+"json\n"+text("config/runtime.defaults.json").rstrip()+"\n"+FENCE)
    out.append(section(26)+"\n\n"+embed("docs/ARCHITECTURE_CONTRACT.md"))
    out.append(section(27))
    out.append("### 27.1 AGENTS.md完整指令\n\n~~~markdown\n"+text("AGENTS.md").rstrip()+"\n~~~")
    out.append("### 27.2 CODEX_TASK.md完整指令\n\n~~~markdown\n"+text("CODEX_TASK.md").rstrip()+"\n~~~")
    out.append(section(28))
    lines=["### 28.1 行为评测索引","","| 用例 | 场景 | 判断依据 |","| --- | --- | --- |"]
    for line in text("evals/behavior-cases.jsonl").splitlines():
        c=json.loads(line)
        lines.append(f"| {c['id']} | {c['name']} | {cell(json.dumps(c['expect'],ensure_ascii=False))} |")
    out.append("\n".join(lines))
    return "\n\n".join(out)+"\n"

if __name__ == "__main__":
    appendix=render_appendix()
    (ROOT/"docs/AGENT_ASSET_APPENDIX.md").write_text(appendix,encoding="utf-8")
    final=text("docs/PRD_BASE_v0.5.1.md").rstrip()+"\n\n"+appendix
    (ROOT/"docs/Seamo_AI_R1_PRD_v0.5.1.md").write_text(final,encoding="utf-8")
    entries=[]
    for p in sorted(ROOT.rglob("*")):
        if not p.is_file() or ".git" in p.parts or "__pycache__" in p.parts or p.name=="asset-manifest.json":
            continue
        entries.append({"path":str(p.relative_to(ROOT)),"bytes":p.stat().st_size,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()})
    manifest={"releaseId":data("config/runtime.defaults.json")["releaseId"],"version":"1.0.1","files":entries}
    (ROOT/"asset-manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(f"Built PRD: {len(final)} characters; manifest: {len(entries)} files")
