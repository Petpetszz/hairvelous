const API_BASE = '/api';
const TOKEN_KEY = 'hairvelous_token';
const USER_KEY = 'hairvelous_user';

// Keep authentication session-only so closing the browser logs the user out.
function getAuthStorage() {
  return window.sessionStorage;
}

// Remove legacy persistent auth keys from prior versions.
function clearLegacyPersistentAuth() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch (_) {}
}
clearLegacyPersistentAuth();

/** After login or registration, open the app with the nav drawer closed first */
function collapseSidebarForFreshLogin() {
  try {
    localStorage.setItem('hairvelous_sidebar_collapsed', '1');
  } catch (_) {}
}

function getToken() {
  try {
    return getAuthStorage().getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function setToken(token) {
  try {
    if (token) getAuthStorage().setItem(TOKEN_KEY, token);
    else getAuthStorage().removeItem(TOKEN_KEY);
  } catch (_) {}
}
function getUser() {
  try {
    return JSON.parse(getAuthStorage().getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}
function setUser(user) {
  try {
    if (user) getAuthStorage().setItem(USER_KEY, JSON.stringify(user));
    else getAuthStorage().removeItem(USER_KEY);
  } catch (_) {}
}
function isLoggedIn() {
  return !!getToken();
}
function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
    return false;
  }
  return true;
}
function requireAdmin() {
  const u = getUser();
  if (!u || (u.roleName !== 'admin' && u.role !== 'admin')) {
    window.location.href = '/dashboard.html';
    return false;
  }
  return true;
}
function logout() {
  clearHairAiResultCache(true);
  setToken(null);
  setUser(null);
  window.location.href = '/login.html';
}

function getHairAiCacheKey(userId) {
  const uid = userId || ((getUser() || {}).userId) || 'guest';
  return `hairAiResult_${uid}`;
}

function setHairAiResultCache(aiResult, userId) {
  try {
    localStorage.setItem(getHairAiCacheKey(userId), JSON.stringify(aiResult || {}));
    // Remove legacy global key to avoid cross-account bleed.
    localStorage.removeItem('hairAiResult');
  } catch (_) {}
}

function getHairAiResultCache(userId) {
  try {
    const scoped = localStorage.getItem(getHairAiCacheKey(userId));
    if (scoped) return scoped;

    // Migrate legacy key once for current user session.
    const legacy = localStorage.getItem('hairAiResult');
    if (legacy) {
      localStorage.setItem(getHairAiCacheKey(userId), legacy);
      localStorage.removeItem('hairAiResult');
      return legacy;
    }
  } catch (_) {}
  return null;
}

function clearHairAiResultCache(clearAllScoped = false) {
  try {
    localStorage.removeItem('hairAiResult');
    localStorage.removeItem(getHairAiCacheKey());
    if (clearAllScoped) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.startsWith('hairAiResult_')) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    }
  } catch (_) {}
}

/** Dashboard URL for the current session (marketing / landing redirects use this). */
function getHomePathForUser() {
  const u = getUser();
  if (!u) return '/landing.html';
  const role = u.roleName || u.role;
  if (role === 'admin') return '/admin_dashboard.html';
  if (role === 'seller') return '/product_management.html';
  if (role === 'specialist') return '/specialist_dashboard.html';
  return '/dashboard.html';
}

async function api(path, options = {}) {
  const url = path.startsWith('http') ? path : API_BASE + path;
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, { ...options, headers });
  const ct = res.headers.get('content-type') || '';
  let data = {};
  if (ct.includes('application/json')) {
    data = await res.json().catch(() => ({}));
  } else {
    const text = await res.text().catch(() => '');
    if (text && !text.trim().startsWith('<')) {
      data = { error: text.slice(0, 300) };
    } else if (!res.ok) {
      data = { error: res.status === 404 ? 'Not found — is the API server running the latest code?' : `HTTP ${res.status}` };
    }
  }
  if (!res.ok) {
    const suspended =
      res.status === 403 &&
      token &&
      (data.code === 'ACCOUNT_SUSPENDED' || /suspended/i.test(String(data.error || data.message || '')));
    if (suspended) {
      setToken(null);
      setUser(null);
      if (!window.__hvAccountSuspendedRedirect) {
        window.__hvAccountSuspendedRedirect = true;
        window.location.replace('/login.html?suspended=1');
      }
    }
    throw { status: res.status, ...data };
  }
  return data;
}

async function apiForm(path, formData, method = 'POST') {
  const url = path.startsWith('http') ? path : API_BASE + path;
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, { method, headers, body: formData });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const suspended =
      res.status === 403 &&
      token &&
      (data.code === 'ACCOUNT_SUSPENDED' || /suspended/i.test(String(data.error || data.message || '')));
    if (suspended) {
      setToken(null);
      setUser(null);
      if (!window.__hvAccountSuspendedRedirect) {
        window.__hvAccountSuspendedRedirect = true;
        window.location.replace('/login.html?suspended=1');
      }
    }
    throw { status: res.status, ...data };
  }
  return data;
}

function showToast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast fixed bottom-4 right-4 px-4 py-3 rounded-lg shadow-lg z-50 ${type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-emerald-600' : 'bg-violet-600'} text-white transform transition-all duration-300`;
  el.style.opacity = '0';
  el.style.transform = 'translateY(20px)';
  el.textContent = message;
  document.body.appendChild(el);
  
  // Animate in
  setTimeout(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  }, 10);
  
  // Animate out and remove
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// Smooth fade in for elements
function fadeIn(element, delay = 0) {
  if (!element) return;
  element.style.opacity = '0';
  element.style.transform = 'translateY(10px)';
  element.style.transition = 'opacity 0.5s ease-out, transform 0.5s ease-out';
  setTimeout(() => {
    element.style.opacity = '1';
    element.style.transform = 'translateY(0)';
  }, delay);
}

// Smooth fade out
function fadeOut(element, callback) {
  if (!element) return;
  element.style.transition = 'opacity 0.3s ease-out, transform 0.3s ease-out';
  element.style.opacity = '0';
  element.style.transform = 'translateY(-10px)';
  setTimeout(() => {
    if (callback) callback();
  }, 300);
}

// Stagger animation for lists
function staggerFadeIn(selector, delay = 100) {
  const elements = document.querySelectorAll(selector);
  elements.forEach((el, index) => {
    fadeIn(el, index * delay);
  });
}