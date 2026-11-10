const $ = (id) => document.getElementById(id);

function showStatus(text, isError) {
  const el = $('status');
  el.className = isError ? 'err' : 'ok';
  el.textContent = text || '';
}

async function load() {
  const stored = await chrome.storage.local.get([
    'apiBase',
    'token',
    'userName',
    'productId',
    'productLabel',
    'autoSave',
    'lastResult',
  ]);
  if (stored.apiBase) $('api').value = stored.apiBase;
  $('session').textContent = stored.token ? `Вход: ${stored.userName || 'да'}` : 'Нужно войти';
  $('auto').checked = stored.autoSave !== false;
  if (stored.productLabel) $('picked').textContent = `Записываем в: ${stored.productLabel}`;
  if (stored.lastResult?.message) {
    showStatus(stored.lastResult.message, !stored.lastResult.ok);
  }
}

$('loginBtn').onclick = async () => {
  showStatus('Вход…');
  const res = await chrome.runtime.sendMessage({
    type: 'login',
    apiBase: $('api').value.trim(),
    login: $('login').value.trim(),
    password: $('password').value,
  });
  if (!res?.ok) {
    showStatus(res?.message || 'Не удалось войти', true);
    return;
  }
  $('password').value = '';
  $('session').textContent = `Вход: ${res.userName}`;
  showStatus('Вход выполнен');
};

let searchTimer;
$('q').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 300);
};

async function search() {
  const q = $('q').value.trim();
  $('results').innerHTML = '';
  if (q.length < 2) return;
  const res = await chrome.runtime.sendMessage({ type: 'search', q });
  if (!res?.ok) {
    showStatus(res?.message || 'Поиск не удался', true);
    return;
  }
  const stored = await chrome.storage.local.get(['productId']);
  for (const product of res.products || []) {
    const li = document.createElement('li');
    li.textContent = `${product.sku ? product.sku + ' — ' : ''}${product.name || product.id}`;
    if (Number(stored.productId) === Number(product.id)) li.className = 'active';
    li.onclick = async () => {
      const label = li.textContent;
      const productId = Number(product.id);
      if (!Number.isFinite(productId) || productId <= 0) {
        showStatus('У товара нет id, выберите другую строку', true);
        return;
      }
      await chrome.storage.local.set({ productId, productLabel: label, lastResult: null });
      $('picked').textContent = `Записываем в: ${label}`;
      showStatus('Товар выбран. Можно записывать конкурентов со страницы.');
      for (const node of $('results').children) node.className = '';
      li.className = 'active';
    };
    $('results').appendChild(li);
  }
  if (!(res.products || []).length) showStatus('Ничего не найдено', true);
}

$('auto').onchange = () => {
  chrome.storage.local.set({ autoSave: $('auto').checked });
};

$('api').onchange = () => {
  chrome.storage.local.set({ apiBase: $('api').value.trim().replace(/\/+$/, '') });
};

$('capture').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'capture-now' });
    if (!res?.ok) showStatus('На этой вкладке нет карточки товара или цена не прочиталась', true);
  } catch {
    showStatus('Откройте карточку Ozon, Wildberries или Яндекс Маркета', true);
  }
};

load();
