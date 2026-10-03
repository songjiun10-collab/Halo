const { TabStrip, Toolbar, Viewport, HaloSheet, Notice, Activity, TabOverview, Button, Logo, Icon, HaloChat, ElsewhereBanner, ResumeBanner } = window.HaloDesignSystem_921175;
const { useState, useEffect, useRef } = React;

function CheckIcon() { return <Icon><path d="M4 12h16M12 4v16"/></Icon>; }

function BrowserShell() {
  const [tab, setTab] = useState("home"); // home | browsing | blocked | approval | done
  const [control, setControl] = useState("agent"); // agent | approval | you
  const [activityOpen, setActivityOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([{ from: "you", text: "Order the cheapest option that ships this week" }, { from: "agent", text: "Found one — $84.20 total, arrives Thursday. Opening checkout." }]);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const closeOverview = () => { const el = document.querySelector(".hx-overview"); if (!el) return setOverviewOpen(false); el.setAttribute("data-leaving", ""); setTimeout(() => setOverviewOpen(false), 220); };
  const [services, setServices] = useState([{ name: "Scheduler LaunchAgent", state: "connected" }, { name: "Routine runner", state: "paused" }]);
  const [memOverridden, setMemOverridden] = useState(false);
  const [events, setEvents] = useState([]);
  const [badge, setBadge] = useState(0);
  const [showSteps, setShowSteps] = useState(false);
  const [swipeHint, setSwipeHint] = useState(null); // "back" | "forward" | null
  const swipeLock = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [claudeOn, setClaudeOn] = useState(true);
  const [gptOn, setGptOn] = useState(false);
  const [claudeKey, setClaudeKey] = useState("sk-ant-••••••••••••7f2a");
  const [gptKey, setGptKey] = useState("");
  const [geminiOn, setGeminiOn] = useState(false);
  const [geminiKey, setGeminiKey] = useState("");
  const [permMode, setPermMode] = useState("ask-risky");
  const [effort, setEffort] = useState("balanced");
  const [agentCfg, setAgentCfg] = useState({ claude: { perm: "ask-risky", effort: "balanced", mode: "parallel" }, gemini: { perm: "ask-all", effort: "fast", mode: "sequential" }, codex: { perm: "ask-risky", effort: "thorough", mode: "parallel" } });
  const [projects, setProjects] = useState([{ id: 1, name: "Shopping", agent: "claude", open: true, items: [{ n: "Order #4821", a: "claude" }, { n: "Price compare", a: "gemini" }] }, { id: 2, name: "Travel", agent: "gemini", open: false, items: [{ n: "Flight search", a: "gemini" }] }]);
  const addProject = () => setProjects(ps => [...ps, { id: Date.now(), name: "New project", agent: "claude", open: true, items: [] }]);
  const toggleProject = id => setProjects(ps => ps.map(x => x.id === id ? { ...x, open: !x.open } : x));
  const cycleAgent = id => setProjects(ps => ps.map(x => x.id === id ? { ...x, agent: ({ claude: "gemini", gemini: "codex", codex: "claude" })[x.agent] } : x));
  const renameProject = (id, name) => setProjects(ps => ps.map(x => x.id === id ? { ...x, name } : x));
  const folderIc = open => <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><path d={open ? "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v1H3zM3 10h18l-1.5 8a2 2 0 01-2 1.6H6.5a2 2 0 01-2-1.6z" : "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"} /></svg>;
  const agentLogos = Object.fromEntries(["claude", "gemini", "codex"].map(n => [n, <img src={"../../assets/logos/" + n + ".png"} width="16" height="16" alt="" style={{ borderRadius: 4, display: "block" }} />]));
  const [homeModel, setHomeModel] = useState("claude");
  const D = { low: "Fastest, lowest cost. Simple, scoped tasks.", med: "Balanced. Everyday tasks.", high: "Complex reasoning and agentic work." };
  const effortSets = {
    claude: { def: 2, lv: [{ l: "Low", s: "Low", d: D.low }, { l: "Medium", s: "Med", d: D.med }, { l: "High", s: "High", d: "Claude default. " + D.high }, { l: "Extra high", s: "Extra", d: "Long-horizon work. Much more thorough." }, { l: "Max", s: "Max", d: "Deepest reasoning, no limit on spend." }] },
    gemini: { def: 2, lv: [{ l: "Low", s: "Low", d: "Smallest thinking budget. " + D.low }, { l: "Medium", s: "Med", d: D.med }, { l: "High", s: "High", d: "Gemini default (dynamic thinking). " + D.high }] },
    codex: { def: 2, lv: [{ l: "Minimal", s: "Min", d: "Almost no reasoning. Quickest replies." }, { l: "Low", s: "Low", d: D.low }, { l: "Medium", s: "Med", d: "GPT-5 default. " + D.med }, { l: "High", s: "High", d: D.high }] }
  };
  const [effortByModel, setEffortByModel] = useState({ claude: 2, gemini: 2, codex: 2 });
  const effSet = effortSets[homeModel];
  const homeEffort = effortByModel[homeModel];
  const setHomeEffort = v => setEffortByModel(m => ({ ...m, [homeModel]: v }));
  const [modelsOpen, setModelsOpen] = useState(false);
  const modelNames = { claude: "Claude Sonnet 4.5", gemini: "Gemini 2.5 Pro", codex: "GPT-5" };
  const agentNames = { claude: "Claude", gemini: "Gemini", codex: "Codex" };
  const [agentOrder, setAgentOrder] = useState(["claude", "gemini", "codex"]);
  const [agentMenu, setAgentMenu] = useState(null);
  const [agentDrag, setAgentDrag] = useState(null);
  const [agentOver, setAgentOver] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [editing, setEditing] = useState(null);
  const [tabNames, setTabNames] = useState({});
  useEffect(() => { if (!ctx) return; const d = e => { if (!e.target.closest(".hx-ctxmenu")) setCtx(null); }; const k = e => { if (e.key === "Escape") setCtx(null); }; window.addEventListener("pointerdown", d); window.addEventListener("keydown", k); return () => { window.removeEventListener("pointerdown", d); window.removeEventListener("keydown", k); }; }, [ctx]);
  const openCtx = (e, type, id) => { e.preventDefault(); setCtx({ type, id, x: Math.min(e.clientX, window.innerWidth - 160), y: Math.min(e.clientY, window.innerHeight - 60) }); };
  const commitName = (v) => { const n = v.trim(); if (n && editing) { if (editing.type === "project") renameProject(editing.id, n); else setTabNames(t => ({ ...t, [editing.id]: n })); } setEditing(null); };
  const nameInput = (cur) => <input className="hx-rename" autoFocus defaultValue={cur} onFocus={e => e.target.select()} onClick={e => e.stopPropagation()} onBlur={e => commitName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") commitName(e.target.value); else if (e.key === "Escape") setEditing(null); e.stopPropagation(); }} />;
  const sbBefore = useRef(true);
  useEffect(() => {
    if (settingsOpen) { sbBefore.current = sidebarOpen; setSidebarOpen(false); setChatOpen(false); setActivityOpen(false); setOverviewOpen(false); setModelsOpen(false); }
    else setSidebarOpen(sbBefore.current);
  }, [settingsOpen]);
  useEffect(() => { if (!agentMenu) return; const d = e => { if (!e.target.closest(".hx-agentmenu")) setAgentMenu(null); }; const k = e => { if (e.key === "Escape") setAgentMenu(null); }; window.addEventListener("pointerdown", d); window.addEventListener("keydown", k); return () => { window.removeEventListener("pointerdown", d); window.removeEventListener("keydown", k); }; }, [agentMenu]);
  const setCfg = (id, k, v) => setAgentCfg(c => ({ ...c, [id]: { ...c[id], [k]: v } }));
  const [theme, setTheme] = useState("dark");
  const [demoOpen, setDemoOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);
  const [activeTabId, setActiveTabId] = useState("1");
  const [resumePrompt, setResumePrompt] = useState(false);
  const restoreFocus = useRef(null);
  function openOverlay(setFn) { restoreFocus.current = document.activeElement; setFn(true); }
  function closeOverlay(setFn) { setFn(false); requestAnimationFrame(() => restoreFocus.current && restoreFocus.current.focus && restoreFocus.current.focus()); }

  const tabs = [
    { id: "1", title: tab === "home" ? "New tab" : "Checkout — Acme", agentState: tab === "home" ? undefined : (tab === "done" ? "done" : tab === "blocked" ? "error" : (control === "you" ? "paused" : "working")) },
    { id: "2", title: "Flight search", agentState: "waiting" },
  ];

  function go(url) {
    setTab("browsing");
    setEvents(e => [...e, { actor: "agent", what: `Opened ${url}` }]);
  }
  function agentTriesBlockedThing() {
    setTab("blocked");
    setEvents(e => [...e, { actor: "halo", what: "Blocked a card submission", detail: "sketchy-payments.example", outcome: "blocked" }]);
    setBadge(b => b + 1);
    setTimeout(() => setTab(t => t === "blocked" ? "browsing" : t), 6000);
  }
  function agentTriesLogin() {
    setTab("blocked-login");
    setControl("approval");
    setEvents(e => [...e, { actor: "halo", what: "Asked to autofill saved sign-in", detail: "vault.example.com" }]);
    setBadge(b => b + 1);
  }
  function approveLogin() {
    setControl("agent");
    setTab("browsing");
    setEvents(e => [...e, { actor: "agent", what: "Signed in via Vault autofill" }]);
  }
  function agentAsksApproval() {
    setTab("approval");
    setControl("approval");
    setEvents(e => [...e, { actor: "halo", what: "Asked for approval", detail: "Pay for order #4821 — $84.20" }]);
    setBadge(b => b + 1);
  }
  function approve() {
    setTab("done");
    setControl("agent");
    setEvents(e => [...e, { actor: "agent", what: "Approved and finished checkout" }]);
  }
  function deny() {
    setTab("browsing");
    setControl("agent");
    setEvents(e => [...e, { actor: "agent", what: "Denied the payment", outcome: "denied" }]);
  }
  function takeover() {
    setControl("you");
    setEvents(e => [...e, { actor: "agent", what: "Handed control to you" }]);
  }
  function resume() {
    setControl("agent");
    setEvents(e => [...e, { actor: "agent", what: "Resumed" }]);
  }

  const controlLabel = control === "agent" ? "Agent is browsing" : control === "approval" ? "Agent is waiting for you" : "You're driving";
  const actionLabel = control === "you" ? "Resume" : "Take over";

  function simulateCrash() {
    setResumePrompt(true);
    setEvents(e => [...e, { actor: "halo", what: "Halo crashed and saved task state", outcome: "error" }]);
  }
  function resumeAfterCrash() {
    setResumePrompt(false);
    setEvents(e => [...e, { actor: "agent", what: "Resumed after crash recovery" }]);
  }
  function discardAfterCrash() {
    setResumePrompt(false);
    goHome();
    setEvents(e => [...e, { actor: "you", what: "Discarded the recovered task" }]);
  }
  function blockedDownload() {
    setEvents(e => [...e, { actor: "halo", what: "Blocked an automatic download", detail: "invoice.exe", outcome: "blocked" }]);
    setBadge(b => b + 1);
  }
  function blockedPopup() {
    setEvents(e => [...e, { actor: "halo", what: "Blocked a pop-up window", detail: "ads.sketchy.example", outcome: "blocked" }]);
    setBadge(b => b + 1);
  }

  function goHome() { setTab("home"); }

  // Safari-matching shortcuts
  useEffect(() => {
    function onKey(e) {
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === "t") { e.preventDefault(); goHome(); }
      else if (k === "w") { e.preventDefault(); goHome(); }
      else if (k === "\\" && e.shiftKey) { e.preventDefault(); if (overviewOpen) closeOverview(); else setOverviewOpen(true); }
      else if (k === ",") { e.preventDefault(); setSettingsOpen(o => !o); }
      else if (k === "l" && !e.shiftKey) { e.preventDefault(); document.querySelector(".hx-omni input, .hx-home__input")?.focus(); }
      else if (k === "l" && e.shiftKey) { e.preventDefault(); setSidebarOpen(o => !o); }
      else if (k === "[") { e.preventDefault(); goHome(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, overviewOpen]);

  // Trackpad two-finger swipe: back to Home / forward to last site
  useEffect(() => {
    function onWheel(e) {
      if (Math.abs(e.deltaX) < 24 || Math.abs(e.deltaX) <= Math.abs(e.deltaY) || swipeLock.current) return;
      swipeLock.current = true;
      if (e.deltaX < 0 && tab !== "home") { setSwipeHint("back"); goHome(); }
      else if (e.deltaX > 0 && tab === "home") { setSwipeHint("forward"); go("shop.example.co.uk"); }
      setTimeout(() => { swipeLock.current = false; setSwipeHint(null); }, 500);
    }
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [tab]);

  return (
    <div className="hx-app">
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true"><filter id="hx-refract" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="2" seed="7" result="n" /><feGaussianBlur in="n" stdDeviation="3" result="nb" /><feDisplacementMap in="SourceGraphic" in2="nb" scale="38" xChannelSelector="R" yChannelSelector="G" /></filter></svg>
      <div className="hx-window">
        <Toolbar domain={tab === "home" ? "" : "shop.example.co.uk"} registrable={tab === "home" ? "" : "example.co.uk"}
          control={control} controlLabel={controlLabel} actionLabel={actionLabel}
          onTakeover={control === "you" ? resume : takeover}
          onOpenOverview={() => (overviewOpen ? closeOverview() : setOverviewOpen(true))} onShare={() => setEvents(e => [...e, { actor: "you", what: "Shared the current tab" }])}
          onSettings={() => (settingsOpen ? closeOverlay(setSettingsOpen) : openOverlay(setSettingsOpen))}
          hideChip={tab === "home"}
          onToggleSidebar={() => setSidebarOpen(o => !o)} onNewTab={goHome} onNavigate={(v) => go(v)} leading={<MacTrafficLights />}
          badgeCount={activityOpen || chatOpen ? 0 : badge} onOpenActivity={() => { setChatOpen(o => !o); setActivityOpen(false); setBadge(0); }} />
        <div className="hx-strip hx-chrome">
        <TabStrip tabs={tabs} activeId="1" onNew={() => go("shop.example.co.uk")} onSelect={() => (overviewOpen ? closeOverview() : setOverviewOpen(true))} />
        </div>
        <div className="hx-window-row">
          <div className="hx-sidebar" data-open={sidebarOpen}>
            <button type="button" className="hx-sidebar__item" data-selected={tab === "home" || undefined} onClick={goHome}>
              <span className="hx-sidebar__fav">+</span><span> New Tab</span>
            </button>
            <p className="hx-sidebar__label">Tabs</p>
            {tabs.map(t => (
              <button type="button" key={t.id} className="hx-sidebar__item" data-selected={t.id === "1" || undefined} onContextMenu={e => openCtx(e, "tab", t.id)}>
                <span className="hx-sidebar__fav">{(tabNames[t.id] || t.title || "?").slice(0, 1)}</span>{editing && editing.type === "tab" && editing.id === t.id ? nameInput(tabNames[t.id] || t.title) : <span>{tabNames[t.id] || t.title}</span>}
              </button>
            ))}
            <p className="hx-sidebar__label">Routines</p>
            {["Daily briefing", "Weekly expense report", "Price-watch flights"].map((r, i) => (
              <button type="button" key={i} className="hx-sidebar__item" data-selected={tab === "routines" && activeTabId === String(i) || undefined} onClick={() => { setTab("routines"); setActiveTabId(String(i)); }}><span className="hx-act" data-state="waiting" style={{ fontSize: 9 }}>Ⅱ</span><span>{r}</span></button>
            ))}
            <p className="hx-sidebar__label hx-sidebar__label--row">Projects<button type="button" className="hx-sidebar__add" aria-label="New project folder" onClick={addProject}>+</button></p>
            {projects.map(pr => (
              <React.Fragment key={pr.id}>
                <div className="hx-proj"><button type="button" className="hx-sidebar__item" onClick={() => toggleProject(pr.id)} onContextMenu={e => openCtx(e, "project", pr.id)} onDoubleClick={() => setEditing({ type: "project", id: pr.id })}>
                  <span className="hx-sidebar__fav">{folderIc(pr.open)}</span>{editing && editing.type === "project" && editing.id === pr.id ? nameInput(pr.name) : <span>{pr.name}</span>}
                </button></div>
                {pr.open ? pr.items.map((it, i) => <div className="hx-proj" key={i}><button type="button" className="hx-sidebar__item hx-sidebar__item--child"><span className="hx-sidebar__fav">{agentLogos[it.a]}</span><span>{it.n}</span></button></div>) : null}
              </React.Fragment>
            ))}
          </div>
          {agentMenu ? (
            <div className="hx-agentmenu" style={{ left: agentMenu.x, top: agentMenu.y }} onContextMenu={e => e.preventDefault()}>
              <strong>{agentNames[agentMenu.id]} settings</strong>
              <label>Permission<select value={agentCfg[agentMenu.id].perm} onChange={e => setCfg(agentMenu.id, "perm", e.target.value)}><option value="read-only">Read-only</option><option value="ask-all">Ask every action</option><option value="ask-risky">Ask for risky only</option><option value="autonomous">Autonomous</option></select></label>
              <label>Effort<select value={agentCfg[agentMenu.id].effort} onChange={e => setCfg(agentMenu.id, "effort", e.target.value)}><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="thorough">Thorough</option></select></label>
              <label>Runs<select value={agentCfg[agentMenu.id].mode} onChange={e => setCfg(agentMenu.id, "mode", e.target.value)}><option value="sequential">Sequential</option><option value="parallel">Parallel</option></select></label>
            </div>
          ) : null}
          {ctx ? <div className="hx-ctxmenu" style={{ left: ctx.x, top: ctx.y }} onContextMenu={e => e.preventDefault()}><button type="button" onClick={() => { setEditing({ type: ctx.type, id: ctx.id }); setCtx(null); }}>Rename</button></div> : null}
          <div className="hx-content-col">
          <div className="hx-body">
          {resumePrompt ? <ResumeBanner reason="crash" taskLabel="Buying order #4821 at shop.example.co.uk" onResume={resumeAfterCrash} onDiscard={discardAfterCrash} /> : null}
          {activeTabId === "1" && tab !== "home" && tabs[1].agentState === "waiting" ? (
            <ElsewhereBanner domain="flights.example.com" taskLabel="Comparing flight prices" onView={() => setActiveTabId("2")} onTakeover={takeover} />
          ) : null}
          {swipeHint ? <div className={"hx-swipe hx-swipe--" + swipeHint}><Icon size={20}><path d={swipeHint === "back" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"}/></Icon></div> : null}
          {tab === "routines" ? (
            <Viewport edgeOn={false} key="routines">
              {(() => {
                const routines = [
                  { name: "Daily briefing", meta: "8:00 AM · every weekday", desc: "Summarizes overnight email, calendar, and news into a short brief." },
                  { name: "Weekly expense report", meta: "Fridays · shop.example.co.uk", desc: "Pulls the week's purchases and files the expense report." },
                  { name: "Price-watch flights", meta: "Runs every 6h", desc: "Checks fares on the saved route and alerts you on a drop." },
                ];
                const r = routines[Number(activeTabId)] || routines[0];
                return (
                  <div>
                    <h2>{r.name}</h2>
                    <p style={{ color: "var(--muted-foreground)", marginTop: 4 }}>{r.meta}</p>
                    <p style={{ marginTop: 16 }}>{r.desc}</p>
                    <div style={{ marginTop: 24, display: "flex", gap: 8 }}>
                      <Button onClick={() => go("shop.example.co.uk")}>Run now</Button>
                      <Button variant="secondary">Edit routine</Button>
                    </div>
                  </div>
                );
              })()}
            </Viewport>
          ) : tab === "home" ? (
            <Viewport home>
              <div className="hx-home">
                <svg className="hx-home__mark" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5"/></svg>
                <div className="hx-home__title">Where should the agent start?</div>
                <div className="hx-home__form">
                  <input className="hx-home__input" placeholder="Work with agent" onKeyDown={(e) => e.key === "Enter" && go(e.target.value || "shop.example.co.uk")} />
                  <div className="hx-mpick" data-open={modelsOpen}>
                    <button type="button" className="hx-mpick__toggle" aria-haspopup="true" aria-expanded={modelsOpen} onClick={() => setModelsOpen(o => !o)}><span>{modelNames[homeModel]}</span><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ transform: modelsOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}><path d="M6 9l6 6 6-6" /></svg></button>
                    {modelsOpen ? (
                      <div className="hx-mpick__pop">
                        <p>Model</p>
                        {["claude", "gemini", "codex"].map(id => <button type="button" key={id} className="hx-mpick__opt" role="radio" aria-checked={homeModel === id} data-on={homeModel === id || undefined} onClick={() => setHomeModel(id)}>{agentLogos[id]}<span>{modelNames[id]}</span></button>)}
                        <p>Effort</p>
                        <div className="hx-effort"><div className="hx-effort__top"><b>{effSet.lv[homeEffort].l}</b><small>{effSet.lv[homeEffort].d}</small></div>
                          <input type="range" min="0" max={effSet.lv.length - 1} step="1" value={homeEffort} aria-label="Effort" onChange={e => setHomeEffort(+e.target.value)} />
                          <div className="hx-effort__ticks">{effSet.lv.map((x, i) => <span key={i} data-on={i === homeEffort || undefined} onClick={() => setHomeEffort(i)}>{x.s}</span>)}</div></div>
                        <p>Permission</p>
                        <select value={permMode} onChange={e => setPermMode(e.target.value)}><option value="read-only">Read-only</option><option value="ask-all">Ask before every action</option><option value="ask-risky">Ask for risky actions only</option><option value="autonomous">Autonomous</option></select>
                      </div>
                    ) : null}
                  </div>
                  <Button onClick={() => go("shop.example.co.uk")}>Go</Button>
                </div>
              </div>
            </Viewport>
          ) : (
            <Viewport edgeOn={control !== "you"} key={tab}>
              <h2>Checkout</h2>
              <dl className="hx-site__rows">
                <div><dt>Subtotal</dt><dd>$79.00</dd></div>
                <div><dt>Shipping</dt><dd>$5.20</dd></div>
                <div className="total"><dt>Total</dt><dd>$84.20</dd></div>
              </dl>
              <a className="hx-site__btn" data-claude-target={tab === "browsing"} onClick={(e) => { e.preventDefault(); if (tab === "browsing") agentAsksApproval(); }}>
                {tab === "done" ? "Paid ✓" : "Pay $84.20"}
              </a>
            </Viewport>
          )}
          <div className="hx-demo-controls" data-open={demoOpen || undefined}>
            <button type="button" className="hx-demo-controls__toggle" onClick={() => setDemoOpen(o => !o)}>Demo controls</button>
            {demoOpen ? (
              <div className="hx-demo-controls__panel">
                <Button variant="secondary" compact onClick={agentTriesBlockedThing}>Simulate a blocked step</Button>
                <Button variant="secondary" compact onClick={agentTriesLogin}>Simulate a Vault sign-in</Button>
                <Button variant="secondary" compact onClick={blockedPopup}>Simulate blocked pop-up</Button>
                <Button variant="secondary" compact onClick={blockedDownload}>Simulate blocked download</Button>
                <Button variant="secondary" compact onClick={simulateCrash}>Simulate crash recovery</Button>
                <Button variant="secondary" compact onClick={() => (overviewOpen ? closeOverview() : setOverviewOpen(true))}>Show all tabs</Button>
              </div>
            ) : null}
          </div>
          <div className="hx-overlays">
            {tab === "blocked" ? <Notice host="sketchy-payments.example" message="tried to submit a card number" onDetails={() => setActivityOpen(true)} /> : null}
            {tab === "approval" ? (
              <HaloSheet from="shop.example.co.uk" title="Pay for order #4821" amount="$84.20"
                facts={[{ label: "Card", value: "•••• 4242" }, { label: "Destination", value: "shop.example.co.uk", mono: true }, { label: "Type", value: "One-time" }, { label: "Scope", value: "This task only" }]}
                approveLabel="Approve $84.20" requestText='{"action":"charge","amount_cents":8420}'
                onTakeover={() => { takeover(); setTab("browsing"); }} onDeny={deny} onApprove={approve} />
            ) : null}
            {activityOpen ? (
              <Activity taskLabel="Buy the order at shop.example.co.uk" events={events} showSteps={showSteps}
                onToggleSteps={() => setShowSteps(s => !s)}
                steps={[{ actor: "agent", what: "Opened checkout" }, { actor: "agent", what: "Filled shipping address" }, { actor: "agent", what: "Selected payment method" }]} />
            ) : null}
            {tab === "blocked-login" ? (
              <HaloSheet from="shop.example.co.uk" title="Sign in with saved credential"
                facts={[{ label: "Account", value: "you@example.com" }, { label: "Vault entry", value: "shop.example.co.uk", mono: true }, { label: "Scope", value: "This task only" }]}
                approveLabel="Autofill & continue" requestText="Credential is filled directly into the page — never exposed to the agent."
                onTakeover={() => { takeover(); setTab("browsing"); }} onDeny={deny} onApprove={approveLogin} />
            ) : null}
            {chatOpen ? (
              <HaloChat taskLabel="Buy the order at shop.example.co.uk" messages={messages}
                recentTasks={[{ label: "Daily briefing", meta: "9:00 AM" }, { label: "Found candidate & drafted notes", meta: "yesterday" }]}
                fleet={{
                  proposedCount: 3,
                  children: [
                    { name: "Checkout agent", status: "running", evidence: "Filled shipping address · shop.example.co.uk" },
                    { name: "Price-compare agent", status: "done", evidence: "Checked 4 sites · found this listing cheapest" },
                    { name: "Notify agent", status: "waiting", evidence: "Will message you once payment is approved" },
                  ],
                  services,
                  memory: { used: 5.8, limit: 8, overridden: memOverridden },
                }}
                cards={[
                  { kind: "newTask", importReady: false },
                  { kind: "taskDetail", harnessProfile: "browser-long", duration: "long", capability: "browser + multi_agent", source: "intent_rule" },
                  { kind: "paused", reason: "goal_not_reached" },
                  { kind: "timeline", events: [{ type: "child_started" }, { type: "routine_step_done" }, { type: "finish_rejected", note: "Order total not yet confirmed on the page" }] },
                  { kind: "goal", state: "active", text: "Order placed and confirmation email received", progress: 60, criteriaMet: 3, criteriaTotal: 5 },
                  { kind: "routines", items: [{ name: "Daily briefing", when: "9:00 AM" }] },
                  { kind: "host", mode: "ask" },
                  { kind: "vault", credentials: [{ site: "shop.example.co.uk", user: "you@example.com" }], memories: ["Prefers Thursday delivery"] },
                  { kind: "import", ready: false, browser: "Chrome" },
                ]}
                onToggleService={(name, state) => setServices(list => list.map(s => s.name === name ? { ...s, state } : s))}
                onRaiseCeiling={() => setMemOverridden(true)}
                onClose={() => closeOverlay(setChatOpen)}
                onSend={(text) => setMessages(m => [...m, { from: "you", text }, { from: "agent", text: "Got it — continuing." }])} />
            ) : null}
          </div>
          {overviewOpen ? (
            <TabOverview selectedId="1" tabs={[{ id: "1", title: tabs[0].title, domain: "shop.example.co.uk", agentState: tabs[0].agentState }, { id: "2", title: "Flight search", domain: "flights.example.com", agentState: "waiting" }]}
              onSelect={() => closeOverview()} />
          ) : null}
          {settingsOpen ? (
            <div className="hx-settings">
              <div className="hx-settings__head">
                <button type="button" className="hx-settings__back" aria-label="Close settings" onClick={() => closeOverlay(setSettingsOpen)}>
                  <Icon size={18}><path d="M15 6l-6 6 6 6"/></Icon>
                </button>
                <h2>Settings</h2>
              </div>
              <div className="hx-settings__body">
                <div className="hx-settings__section">
                  <p className="hx-settings__label">Connected models</p>
                  <div className="hx-model-row hx-model-row--col">
                    <div className="hx-model-row__top">
                      <div className="hx-model-row__mark">{agentLogos.claude}</div>
                      <div className="hx-model-row__body">
                        <div className="hx-model-row__name">Claude</div>
                        <div className="hx-model-row__meta" data-mono>{claudeOn ? "connected · claude-sonnet-4.5" : "not connected"}</div>
                      </div>
                      <button type="button" className="hx-switch" data-on={claudeOn || undefined} aria-label="Toggle Claude" onClick={() => setClaudeOn(v => !v)} />
                    </div>
                    <div className="hx-model-row__key">
                      <input type="password" value={claudeKey} onChange={e => setClaudeKey(e.target.value)} placeholder="sk-ant-…" />
                      <button type="button" onClick={() => setClaudeOn(true)}>Save</button>
                    </div>
                    <p className="hx-model-row__hint">Stored locally, never sent to Halo.</p>
                  </div>
                  <div className="hx-model-row hx-model-row--col">
                    <div className="hx-model-row__top">
                      <div className="hx-model-row__mark">{agentLogos.codex}</div>
                      <div className="hx-model-row__body">
                        <div className="hx-model-row__name">Codex (ChatGPT)</div>
                        <div className="hx-model-row__meta" data-mono>{gptOn ? "connected · gpt-5" : "not connected"}</div>
                      </div>
                      <button type="button" className="hx-switch" data-on={gptOn || undefined} aria-label="Toggle ChatGPT" onClick={() => setGptOn(v => !v)} />
                    </div>
                    <div className="hx-model-row__key">
                      <input type="password" value={gptKey} onChange={e => setGptKey(e.target.value)} placeholder="sk-…" />
                      <button type="button" onClick={() => setGptOn(!!gptKey)}>Save</button>
                    </div>
                    <p className="hx-model-row__hint">Stored locally, never sent to Halo.</p>
                  </div>
                  <div className="hx-model-row hx-model-row--col">
                    <div className="hx-model-row__top">
                      <div className="hx-model-row__mark">{agentLogos.gemini}</div>
                      <div className="hx-model-row__body">
                        <div className="hx-model-row__name">Gemini</div>
                        <div className="hx-model-row__meta" data-mono>{geminiOn ? "connected · gemini-2.5-pro" : "not connected"}</div>
                      </div>
                      <button type="button" className="hx-switch" data-on={geminiOn || undefined} aria-label="Toggle Gemini" onClick={() => setGeminiOn(v => !v)} />
                    </div>
                    <div className="hx-model-row__key">
                      <input type="password" value={geminiKey} onChange={e => setGeminiKey(e.target.value)} placeholder="AI…" />
                      <button type="button" onClick={() => setGeminiOn(!!geminiKey)}>Save</button>
                    </div>
                    <p className="hx-model-row__hint">Stored locally, never sent to Halo.</p>
                  </div>
                </div>
                <div className="hx-settings__section">
                  <p className="hx-settings__label">Permission mode</p>
                  <div className="hx-perm-list">
                    {[
                      { id: "read-only", name: "Read-only", desc: "Agent can look, never act. Every click needs you." },
                      { id: "ask-all", name: "Ask before every action", desc: "Safest. Halo confirms each step." },
                      { id: "ask-risky", name: "Ask for risky actions only", desc: "Payments, sign-ins, and sending are gated — routine browsing isn't." },
                      { id: "autonomous", name: "Full autonomy", desc: "Agent acts without asking. Everything still lands in Activity." },
                    ].map((p, i) => (
                      <button type="button" key={p.id} className="hx-perm" data-selected={permMode === p.id || undefined} onClick={() => setPermMode(p.id)}>
                        <span className="hx-perm__dot"></span>
                        <span className="hx-perm__body">
                          <span className="hx-perm__name">{p.name}</span>
                          <span className="hx-perm__desc">{p.desc}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="hx-settings__section">
                  <p className="hx-settings__label">Effort</p>
                  <div className="hx-effort">
                    {[{ id: "fast", name: "Fast" }, { id: "balanced", name: "Balanced" }, { id: "thorough", name: "Thorough" }].map(e => (
                      <button type="button" key={e.id} data-on={effort === e.id || undefined} onClick={() => setEffort(e.id)}>{e.name}</button>
                    ))}
                  </div>
                  <p className="hx-model-row__hint">
                    {effort === "fast" ? "Quick answers for simple, low-stakes steps." : effort === "thorough" ? "Agent reasons longer and double-checks before acting — slower, fewer mistakes." : "Balances speed and care for everyday browsing."}
                    
                  </p>
                </div>
                <div className="hx-settings__section">
                  <p className="hx-settings__label">Appearance</p>
                  <div className="hx-effort">
                    {["dark", "light"].map(t => (
                      <button type="button" key={t} data-on={theme === t || undefined} onClick={() => setTheme(t)}>{t === "dark" ? "Dark" : "Light"}</button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<BrowserShell />);
