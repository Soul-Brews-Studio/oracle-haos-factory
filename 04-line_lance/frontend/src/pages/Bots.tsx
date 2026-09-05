import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import Shell from "../components/Shell";
import type { BotInput, LineBot } from "../types";

interface BotForm {
  id: string;
  name: string;
  channel_secret: string;
  channel_access_token: string;
  bot_user_id: string;
  enabled: boolean;
  clear_channel_secret: boolean;
  clear_channel_access_token: boolean;
}

const emptyForm: BotForm = {
  id: "",
  name: "",
  channel_secret: "",
  channel_access_token: "",
  bot_user_id: "",
  enabled: true,
  clear_channel_secret: false,
  clear_channel_access_token: false,
};

const controlClass = "control w-full text-base sm:text-sm";

function message(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.status === 403) return "Bot changes are available only through the Home Assistant admin Ingress.";
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function Bots() {
  const [bots, setBots] = useState<LineBot[]>([]);
  const [form, setForm] = useState<BotForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [focusTarget, setFocusTarget] = useState<"id" | "name" | null>(null);
  const confirmDelete = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLElement>(null);
  const idInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const enabledCount = useMemo(() => bots.filter((bot) => bot.enabled).length, [bots]);

  useEffect(() => { void loadBots(); }, []);
  useEffect(() => { confirmDelete.current?.focus(); }, [pendingDelete]);
  useEffect(() => {
    if (!focusTarget) return;
    const frame = requestAnimationFrame(() => {
      (focusTarget === "id" ? idInput : nameInput).current?.focus({ preventScroll: true });
      editor.current?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      setFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [editingId, focusTarget]);

  async function loadBots() {
    setLoading(true);
    setLoadError("");
    try {
      setBots(await api.bots());
    } catch (caught) {
      setLoadError(message(caught, "Could not load the bot registry."));
    } finally {
      setLoading(false);
    }
  }

  function update<K extends keyof BotForm>(key: K, value: BotForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
  }

  function showEditor(target: "id" | "name") {
    setFocusTarget(target);
  }

  function add() {
    resetForm();
    setPendingDelete(null);
    setActionError("");
    setNotice("");
    showEditor("id");
  }

  function edit(bot: LineBot) {
    setEditingId(bot.id);
    setPendingDelete(null);
    setActionError("");
    setNotice("");
    setForm({
      id: bot.id,
      name: bot.name,
      channel_secret: "",
      channel_access_token: "",
      bot_user_id: bot.bot_user_id || "",
      enabled: bot.enabled,
      clear_channel_secret: false,
      clear_channel_access_token: false,
    });
    showEditor("name");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError("");
    setNotice("");
    if (!form.id.trim() || !form.name.trim()) {
      setActionError("Bot ID and display name are required.");
      return;
    }
    const payload: BotInput = {
      id: form.id.trim(),
      name: form.name.trim(),
      bot_user_id: form.bot_user_id.trim() || null,
      enabled: form.enabled,
    };
    if (form.channel_secret.trim()) payload.channel_secret = form.channel_secret.trim();
    if (form.channel_access_token.trim()) payload.channel_access_token = form.channel_access_token.trim();
    if (editingId && form.clear_channel_secret) payload.channel_secret = null;
    if (editingId && form.clear_channel_access_token) payload.channel_access_token = null;

    setSaving(true);
    try {
      if (editingId) {
        const { id: _, ...patch } = payload;
        await api.updateBot(editingId, patch);
      } else {
        await api.saveBot(payload);
      }
      const action = editingId ? "updated" : "added";
      resetForm();
      await loadBots();
      setNotice(`Bot ${action}. Stored credentials remain masked.`);
    } catch (caught) {
      setActionError(message(caught, "Could not save this bot."));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setActionError("");
    setNotice("");
    setDeletingId(id);
    try {
      await api.deleteBot(id);
      setBots((current) => current.filter((bot) => bot.id !== id));
      if (editingId === id) resetForm();
      setPendingDelete(null);
      setNotice("Bot removed from the local registry.");
    } catch (caught) {
      setActionError(message(caught, "Could not remove this bot."));
    } finally {
      setDeletingId(null);
    }
  }

  return <Shell>
    <header className="page-header">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0"><h1 className="page-title mb-0">LINE Bots</h1><p className="section-copy mt-2 max-w-[72ch]">A private control registry for bot identity and credentials. Secret material stays encrypted and write-only.</p></div>
        <button type="button" className="primary-button w-full sm:w-auto" onClick={add}>Add bot</button>
      </div>
      <div className="bot-summary" role="status"><span><strong>{enabledCount}</strong> enabled</span><span><strong>{bots.length}</strong> registered</span><span>Ingress only</span><span>Secrets encrypted</span></div>
    </header>

    {loadError && <div className="notice notice-error" role="alert"><strong>Could not load the bot registry.</strong><span>{loadError}</span><button type="button" className="notice-action" onClick={() => void loadBots()}>Retry loading</button></div>}
    {actionError && <div className="notice notice-error" role="alert"><strong>Bot registry action failed.</strong><span>{actionError}</span></div>}
    {notice && <div className="notice notice-success" role="status"><strong>{notice}</strong></div>}

    <div className="bot-workspace">
      <section className="card p-0 min-w-0">
        <div className="px-4 py-4 sm:px-5 border-b border-border"><h2 className="section-title">Registered bots</h2><p className="section-copy">Scan readiness without exposing a single credential value.</p></div>
        {loading ? <div className="p-5" role="status" aria-label="Loading registered bots"><div className="bot-skeleton" /><div className="bot-skeleton mt-3" /></div>
          : bots.length === 0 ? <div className="px-5 py-12 text-center"><h3 className="font-semibold">No bots registered</h3><p className="section-copy mx-auto max-w-[58ch]">Start with identity metadata; credentials can be attached or rotated later.</p><button type="button" className="secondary-button mt-5" onClick={add}>Add the first bot</button></div>
          : <div className="divide-y divide-border">{bots.map((bot) => <article className="bot-row" key={bot.id}>
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="break-words">{bot.name}</strong><span className={`badge ${bot.enabled ? "badge-group" : "bot-disabled"}`}>{bot.enabled ? "enabled" : "disabled"}</span></div><code className="mt-1 block text-xs text-accent break-all">{bot.id}</code>{bot.bot_user_id && <code className="mt-2 block text-xs text-text-muted break-all">{bot.bot_user_id}</code>}</div>
            <dl className="bot-credential-state"><div><dt>Secret</dt><dd>{bot.has_secret ? "configured" : "not set"}</dd></div><div><dt>Token</dt><dd>{bot.has_token ? "configured" : "not set"}</dd></div></dl>
            <div className="flex flex-wrap gap-2 sm:justify-end" aria-live="polite"><button type="button" className="secondary-button" disabled={deletingId === bot.id} onClick={() => edit(bot)}>Edit</button>{pendingDelete === bot.id ? <><button ref={confirmDelete} type="button" className="danger-button" disabled={deletingId === bot.id} onClick={() => void remove(bot.id)}>{deletingId === bot.id ? "Removing…" : "Confirm removal"}</button><button type="button" className="secondary-button" disabled={deletingId === bot.id} onClick={() => setPendingDelete(null)}>Keep bot</button></> : <button type="button" className="secondary-button" disabled={deletingId === bot.id} onClick={() => setPendingDelete(bot.id)}>Remove</button>}</div>
          </article>)}</div>}
      </section>

      <aside className="min-w-0">
        <section ref={editor} className="card bot-editor" aria-labelledby="bot-editor-title">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="min-w-0 flex-1"><h2 id="bot-editor-title" className="section-title break-all">{editingId ? `Edit ${editingId}` : "Add a bot"}</h2><p className="section-copy">Letters, numbers, underscores, and hyphens form the permanent bot ID.</p></div>
            {editingId && <button type="button" className="secondary-button" onClick={add}>Cancel</button>}
          </div>
          <form className="mt-5 grid gap-4" onSubmit={save}>
            <label className="form-field"><span>Bot ID</span><input ref={idInput} className={controlClass} required maxLength={64} pattern="[A-Za-z0-9_-]+" autoComplete="off" disabled={Boolean(editingId)} value={form.id} onChange={(event) => update("id", event.target.value)} placeholder="support-line" /></label>
            <label className="form-field"><span>Display name</span><input ref={nameInput} className={controlClass} required maxLength={128} autoComplete="off" value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Support LINE" /></label>
            <label className="form-field"><span>Channel secret <small>optional</small></span><input className={controlClass} type="password" autoComplete="new-password" maxLength={512} disabled={form.clear_channel_secret} value={form.channel_secret} onChange={(event) => update("channel_secret", event.target.value)} placeholder={editingId ? "Leave blank to retain" : "Paste channel secret"} /></label>
            {editingId && bots.find((bot) => bot.id === editingId)?.has_secret && <label className="credential-clear"><input type="checkbox" checked={form.clear_channel_secret} onChange={(event) => update("clear_channel_secret", event.target.checked)} />Clear the stored secret</label>}
            <label className="form-field"><span>Channel access token <small>optional</small></span><input className={controlClass} type="password" autoComplete="new-password" maxLength={4096} disabled={form.clear_channel_access_token} value={form.channel_access_token} onChange={(event) => update("channel_access_token", event.target.value)} placeholder={editingId ? "Leave blank to retain" : "Paste access token"} /></label>
            {editingId && bots.find((bot) => bot.id === editingId)?.has_token && <label className="credential-clear"><input type="checkbox" checked={form.clear_channel_access_token} onChange={(event) => update("clear_channel_access_token", event.target.checked)} />Clear the stored token</label>}
            <label className="form-field"><span>Bot user ID <small>optional</small></span><input className={controlClass} maxLength={128} autoComplete="off" value={form.bot_user_id} onChange={(event) => update("bot_user_id", event.target.value)} placeholder="U…" /></label>
            <label className="min-h-11 flex items-center gap-3 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-hover"><input type="checkbox" className="h-5 w-5 accent-accent" checked={form.enabled} onChange={(event) => update("enabled", event.target.checked)} /><span className="text-sm font-semibold">Enabled for local control-plane use</span></label>
            <button type="submit" className="primary-button w-full" disabled={saving}>{saving ? "Saving…" : editingId ? "Save changes" : "Add bot"}</button>
          </form>
        </section>
        <div className="security-panel"><strong>Credential boundary</strong><p>Encrypted in protected add-on data, never returned by the API, and never used to create a public webhook from this screen.</p></div>
      </aside>
    </div>
  </Shell>;
}
