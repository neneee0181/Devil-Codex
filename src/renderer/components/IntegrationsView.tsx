import { useEffect, useMemo, useState } from "react";
import { Check, Cuboid, Plug, RefreshCw, Search } from "lucide-react";
import type { CodexSkillInfo, McpServerInfo } from "../../shared/contracts";

type IntegrationTab = "plugins" | "skills";

const ACCENTS = ["#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ec4899", "#06b6d4", "#ef4444", "#14b8a6"];
function accent(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return ACCENTS[hash % ACCENTS.length];
}

function displayScope(scope: string): string {
  if (scope === "personal") return "개인";
  if (scope === "system") return "시스템";
  if (scope === "recommended") return "권장";
  return scope || "스킬";
}

function pluginStatus(server: McpServerInfo): string {
  if (server.authStatus === "authenticated") return "연결됨";
  if (server.authStatus === "unsupported") return "연결됨";
  return server.authStatus || "연결됨";
}

export function IntegrationsView({ skills, threadId, cwd }: { skills: CodexSkillInfo[]; threadId: string | null; cwd: string }): React.JSX.Element {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [localSkills, setLocalSkills] = useState<CodexSkillInfo[]>(skills);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<IntegrationTab>("plugins");

  useEffect(() => setLocalSkills(skills), [skills]);

  const load = async (forceReload = false): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const [nextServers, nextSkills] = await Promise.all([
        window.devilCodex.listMcpServers({ ...(threadId ? { threadId } : {}) }),
        cwd ? window.devilCodex.listSkills({ cwd, forceReload }) : Promise.resolve([]),
      ]);
      setServers(nextServers);
      setLocalSkills(nextSkills.filter((skill) => skill.enabled));
    }
    catch (loadError) { setError(String(loadError)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [cwd, threadId]);

  const q = query.trim().toLowerCase();
  const visibleSkills = useMemo(() => localSkills.filter((s) => !q || `${s.name} ${s.description} ${s.scope}`.toLowerCase().includes(q)), [localSkills, q]);
  const visibleServers = useMemo(() => servers.filter((s) => !q || s.name.toLowerCase().includes(q) || s.tools.some((t) => `${t.title} ${t.name}`.toLowerCase().includes(q))), [servers, q]);
  const title = tab === "plugins" ? "플러그인" : "기술";
  const lead = tab === "plugins" ? "순정 Codex에 연결된 플러그인 상태를 표시합니다" : "현재 Codex에서 사용할 수 있는 스킬 목록입니다";
  const placeholder = tab === "plugins" ? "플러그인 검색" : "스킬 검색";

  return <div className="plugins-page">
    <div className="plugins-top">
      <div className="plugins-tabs">
        <button className={tab === "plugins" ? "active" : ""} type="button" onClick={() => { setTab("plugins"); setQuery(""); }}>플러그인</button>
        <button className={tab === "skills" ? "active" : ""} type="button" onClick={() => { setTab("skills"); setQuery(""); }}>스킬</button>
      </div>
      <div className="plugins-top-actions"><button type="button" onClick={() => void load(true)} aria-label="새로 고침"><RefreshCw size={15} /></button></div>
    </div>

    <div className="plugins-body">
      <h1>{title}</h1>
      <p className="plugins-lead">{lead}</p>

      <div className="plugins-search">
        <Search size={17} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} />
      </div>

      {error && <div className="integration-error">{error}</div>}

      {tab === "plugins" ? <section className="plugins-cat">
        <h3>연결됨 <span>{visibleServers.length}</span></h3>
        {loading ? <div className="plugins-empty">플러그인 상태 확인 중...</div> : visibleServers.length === 0 ? <div className="plugins-empty"><Plug size={20} />연결된 플러그인 없음</div> : <div className="plugins-grid wide">{visibleServers.map((server) => (
          <article className="plugin-card mcp" key={server.name}>
            <div className="plugin-card-head">
              <span className="plugin-card-icon" style={{ background: accent(server.name) }}><Plug size={20} /></span>
              <div className="plugin-card-body"><strong>{server.name}</strong><p>도구 {server.tools.length}개 · 리소스 {server.resources}개</p></div>
              <span className="plugin-card-check" title={pluginStatus(server)}><Check size={17} /></span>
            </div>
            {server.tools.length > 0 && <div className="plugin-tools readonly">{server.tools.map((tool) => (
              <div key={tool.name} className="plugin-tool"><span><strong>{tool.title || tool.name}</strong><small>{tool.description || tool.name}</small></span></div>
            ))}</div>}
          </article>
        ))}</div>}
        <p className="plugins-note">연결 추가와 설정 변경은 순정 Codex에서 진행해야 합니다.</p>
      </section> : <section className="plugins-cat">
        <h3>Installed <span>{visibleSkills.length}</span></h3>
        <div className="plugins-grid">{visibleSkills.map((skill) => (
          <article className="plugin-card" key={skill.path}>
            <span className="plugin-card-icon" style={{ background: accent(skill.name) }}><Cuboid size={20} /></span>
            <div className="plugin-card-body"><strong>{skill.name}</strong><p>{skill.description || "설명 없음"}</p></div>
            <span className="plugin-card-tag">{displayScope(skill.scope)}</span>
            <span className="plugin-card-check" title="사용 가능"><Check size={17} /></span>
          </article>
        ))}{visibleSkills.length === 0 && <div className="plugins-empty">일치하는 스킬 없음</div>}</div>
        <p className="plugins-note">스킬 설치와 제거는 순정 Codex의 스킬 화면에서 관리합니다.</p>
      </section>}
    </div>
  </div>;
}
