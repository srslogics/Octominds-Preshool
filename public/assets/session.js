window.OctomindsSession = (() => {
  const key = 'octominds.inventory.session';
  const logoutKey = `${key}.logout`;
  const signedOutKey = `${key}.signedOut`;

  function parse(value) {
    try { return JSON.parse(value); } catch { return null; }
  }

  function read(storage) {
    return parse(storage.getItem(key));
  }

  async function sessionId(session) {
    if (session?.browser_session_id) return session.browser_session_id;
    if (!session?.refresh_token) return null;
    // Older saved sessions have no browser ID. Match them without sharing a credential.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session.refresh_token));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function matches(session, other, id = session?.browser_session_id) {
    if (!session || !other) return false;
    if (id && other.browser_session_id) return id === other.browser_session_id;
    return Boolean(session.refresh_token && session.refresh_token === other.refresh_token);
  }

  function restore() {
    if (sessionStorage.getItem(signedOutKey)) return null;
    const tab = read(sessionStorage);
    const remembered = read(localStorage);
    return matches(tab, remembered) ? remembered : tab || remembered;
  }

  function save(session, remember, previous) {
    const stored = { ...session, browser_session_id: crypto.randomUUID() };
    sessionStorage.removeItem(signedOutKey);
    sessionStorage.setItem(key, JSON.stringify(stored));
    if (remember) localStorage.setItem(key, JSON.stringify(stored));
    else if (matches(previous, read(localStorage))) localStorage.removeItem(key);
    return stored;
  }

  function clear(session) {
    sessionStorage.removeItem(key);
    sessionStorage.setItem(signedOutKey, '1');
    if (matches(session, read(localStorage))) localStorage.removeItem(key);
  }

  function changed() {
    return new Error('Your session changed. Please sign in again.');
  }

  async function refresh(previous, isCurrent, exchange, revoke) {
    const id = await sessionId(previous);
    const update = async () => {
      if (!isCurrent()) throw changed();
      const shared = read(localStorage);
      if (matches(previous, shared, id) && shared.access_token !== previous.access_token) {
        sessionStorage.setItem(key, JSON.stringify(shared));
        return shared;
      }
      const next = { ...await exchange(previous.refresh_token), browser_session_id: id };
      const logout = parse(localStorage.getItem(logoutKey));
      if (!isCurrent() || (id && logout?.id === id)) {
        await revoke(next.access_token, logout?.id === id ? logout.scope : 'local').catch(() => {});
        throw changed();
      }
      sessionStorage.setItem(key, JSON.stringify(next));
      if (matches(previous, read(localStorage), id)) localStorage.setItem(key, JSON.stringify(next));
      return next;
    };
    // Remembered sessions can be renewed by any open app. Rotate their tokens once.
    return navigator.locks && id ? navigator.locks.request(`${key}.${id}`, update) : update();
  }

  async function signOut(session, account, scope, revoke) {
    const remembered = read(localStorage);
    const id = await sessionId(session);
    const latest = matches(session, remembered, id) ? remembered : session;
    if (matches(session, read(localStorage), id)) localStorage.removeItem(key);
    if (id || (scope === 'global' && account)) {
      localStorage.setItem(logoutKey, JSON.stringify({ id, account, scope, event: crypto.randomUUID() }));
    }
    if (latest?.access_token) await revoke(latest.access_token, scope);
  }

  async function signedOut(event, session, account) {
    if (event.key !== logoutKey || !session) return false;
    const logout = parse(event.newValue);
    return Boolean((logout?.scope === 'global' && account && logout.account === account) ||
      (logout?.id && logout.id === await sessionId(session)));
  }

  function protectHistory(workspace, isSignedIn) {
    let needsCheck = false;
    window.addEventListener('pagehide', (event) => {
      if (event.persisted && isSignedIn()) {
        workspace.hidden = true;
        needsCheck = true;
      }
    });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted && needsCheck) location.reload();
    });
  }

  return { restore, save, clear, refresh, signOut, signedOut, protectHistory };
})();
