const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const config = window.OCTOMINDS_CONFIG || {};
const authView = $('#authView');
const appView = $('#appView');
const toast = $('#toast');
const SESSION_KEY = 'octominds.auth.session';
let session = null;
let toastTimer;
let authStage = 'phone';
let pendingPhone = '';

function configured() {
  return Boolean(config.supabaseUrl && config.supabaseAnonKey && config.apiBaseUrl);
}

function showToast(message, kind = 'info') {
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function setAuthBusy(busy) {
  const button = $('#loginForm [type="submit"]');
  button.disabled = busy;
  button.innerHTML = busy ? (authStage === 'phone' ? 'Sending OTP…' : 'Verifying…') : (authStage === 'phone' ? 'Send OTP <span>→</span>' : 'Verify and sign in <span>→</span>');
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${config.supabaseUrl}/auth/v1${path}`, {
    ...options,
    headers: { apikey: config.supabaseAnonKey, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || payload.msg || payload.message || 'Authentication request failed');
  return payload;
}

async function apiRequest(path, options = {}) {
  if (!session?.access_token) throw new Error('Authentication required');
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || 'Application request failed');
  return payload;
}

function saveSession(value, persistent) {
  session = value;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
  if (persistent) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else localStorage.removeItem(SESSION_KEY);
}

function clearSession() {
  session = null;
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_KEY);
}

function showLogin() {
  appView.classList.add('hidden');
  authView.classList.remove('hidden');
}

async function showApplication() {
  const current = await apiRequest('/api/v1/session');
  const roleLabel = current.role_label || current.role.replaceAll('_', ' ');
  $('#sessionRole').textContent = roleLabel;
  $('#sessionBranch').textContent = current.branch_name || (current.branch_id ? 'Assigned branch' : 'All branches');
  const loginIdentity = current.phone || current.email;
  $('#sessionEmail').textContent = loginIdentity;
  $('.profile-copy strong').textContent = current.full_name || loginIdentity;
  $('.profile-copy small').textContent = roleLabel;
  const initials = (current.full_name || 'OctoMinds User').split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
  $$('.avatar').forEach((avatar) => { avatar.textContent = initials; });
  $('#branchButton').firstChild.textContent = `${current.branch_name || 'All branches'} `;
  $('#drawerName').textContent = current.full_name || loginIdentity;
  $('#drawerRole').textContent = roleLabel;
  $('#drawerBranch').textContent = current.branch_name || 'All branches';
  $('#drawerEmail').textContent = loginIdentity;
  $('#drawerAccess').textContent = roleLabel;
  $('#pageTitle').textContent = `Good morning, ${(current.full_name || 'there').split(' ')[0]}`;
  authView.classList.add('hidden');
  appView.classList.remove('hidden');
  await checkHealth();
}

async function requestOtp(phone) {
  await supabaseRequest('/otp', { method: 'POST', body: JSON.stringify({ phone, create_user: false, channel: 'sms' }) });
}

async function verifyOtp(phone, token, persistent) {
  const value = await supabaseRequest('/verify', { method: 'POST', body: JSON.stringify({ type: 'sms', phone, token }) });
  saveSession(value, persistent);
  try { await showApplication(); } catch (error) { clearSession(); throw error; }
}

function showPhoneStage() {
  authStage = 'phone';
  pendingPhone = '';
  $('#phoneStage').classList.remove('hidden');
  $('#otpStage').classList.add('hidden');
  $('#resendOtp').classList.add('hidden');
  $('#phone').required = true;
  $('#otp').required = false;
  $('#otp').value = '';
  setAuthBusy(false);
}

function showOtpStage(phone) {
  authStage = 'otp';
  pendingPhone = phone;
  $('#phoneStage').classList.add('hidden');
  $('#otpStage').classList.remove('hidden');
  $('#resendOtp').classList.remove('hidden');
  $('#phone').required = false;
  $('#otp').required = true;
  $('#otpPhone').textContent = phone.replace(/(\+91)(\d{2})(\d{4})(\d{4})/, '$1 $2••••$4');
  $('#otp').focus();
  setAuthBusy(false);
}

async function restoreSession() {
  if (!configured()) return;
  const stored = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
  if (!stored) return;
  try {
    session = JSON.parse(stored);
    if (session.expires_at && session.expires_at * 1000 <= Date.now() && session.refresh_token) {
      const refreshed = await supabaseRequest('/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }) });
      saveSession(refreshed, Boolean(localStorage.getItem(SESSION_KEY)));
    }
    await showApplication();
  } catch { clearSession(); showLogin(); }
}

async function checkHealth() {
  const apiHealth = $('#apiHealth');
  const authHealth = $('#authHealth');
  const dataHealth = $('#dataHealth');
  apiHealth.textContent = authHealth.textContent = dataHealth.textContent = 'Checking…';
  try {
    const response = await fetch(`${config.apiBaseUrl}/health`);
    if (!response.ok) throw new Error();
    apiHealth.textContent = 'Available'; apiHealth.className = 'good';
    authHealth.textContent = session?.access_token ? 'Verified' : 'Signed out'; authHealth.className = session?.access_token ? 'good' : 'warn';
    dataHealth.textContent = 'Connected'; dataHealth.className = 'good';
  } catch {
    apiHealth.textContent = 'Unavailable'; apiHealth.className = 'alert';
    authHealth.textContent = session?.access_token ? 'Token present' : 'Signed out'; authHealth.className = 'warn';
    dataHealth.textContent = 'Unavailable'; dataHealth.className = 'alert';
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!configured()) {
    $('#configurationNotice').classList.remove('hidden');
    showToast('Application environments are not configured yet', 'error');
    return;
  }
  setAuthBusy(true);
  try {
    if (authStage === 'phone') {
      const nationalNumber = $('#phone').value.replace(/\D/g, '');
      if (!/^[6-9]\d{9}$/.test(nationalNumber)) throw new Error('Enter a valid 10-digit Indian mobile number');
      const phone = `+91${nationalNumber}`;
      await requestOtp(phone);
      showOtpStage(phone);
      showToast('OTP sent securely');
    } else {
      await verifyOtp(pendingPhone, $('#otp').value.trim(), $('#rememberSession').checked);
      showToast('Signed in securely');
    }
  } catch (error) { showToast(error.message, 'error'); }
  finally { setAuthBusy(false); }
});

$('#logoutButton').addEventListener('click', async () => {
  try {
    if (session?.access_token) await supabaseRequest('/logout', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` } });
  } catch { /* Clear the local session even if remote sign-out is unavailable. */ }
  clearSession(); showLogin(); showToast('Signed out');
});

$('#changePhone').addEventListener('click', showPhoneStage);
$('#resendOtp').addEventListener('click', async () => {
  if (!pendingPhone) return;
  try { await requestOtp(pendingPhone); showToast('A new OTP has been sent'); }
  catch (error) { showToast(error.message, 'error'); }
});

const sidebar = $('#sidebar');
const scrim = $('#scrim');
function setNav(open) { sidebar.classList.toggle('open', open); scrim.classList.toggle('show', open); }
$('#openNav').addEventListener('click', () => setNav(true));
$('#closeNav').addEventListener('click', () => setNav(false));
scrim.addEventListener('click', () => setNav(false));
$$('.nav-item').forEach((item) => item.addEventListener('click', (event) => {
  event.preventDefault();
  if (item.dataset.view !== 'Overview') return showToast(`${item.dataset.view} is not part of Phase 1 yet`);
  $$('.nav-item').forEach((link) => link.classList.remove('active'));
  item.classList.add('active'); setNav(false);
}));

const drawer = $('#profileDrawer');
function setDrawer(open) { drawer.classList.toggle('open', open); drawer.setAttribute('aria-hidden', String(!open)); }
$('#profileButton').addEventListener('click', () => setDrawer(true));
$('#closeDrawer').addEventListener('click', () => setDrawer(false));
$('#refreshHealth').addEventListener('click', checkHealth);
$('#notificationButton').addEventListener('click', () => showToast('No unread notifications'));
$('#searchButton').addEventListener('click', () => showToast('Search becomes available with the operational modules'));
$('#branchButton').addEventListener('click', () => showToast('Branch access is controlled by your assigned membership'));
$('#exportButton').addEventListener('click', () => showToast('There is no operational data to export yet'));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { setDrawer(false); setNav(false); } });

if (!configured()) $('#configurationNotice').classList.remove('hidden');
$('#todayLabel').textContent = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()).toUpperCase();
restoreSession();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
