import React, { useRef } from 'react';
import { Button } from '../Button/Button';

function formatUserLabel(u) {
  if (!u) return '';
  const name =
    u.full_name ||
    [u.last_name, u.first_name].filter(Boolean).join(' ') ||
    u.email ||
    `User #${u.id ?? u.user_id ?? u.userId}`;
  return u.email && !String(name).includes(u.email) ? `${name} (${u.email})` : name;
}

export function InviteUserButton({
  users = [],
  onInvite,
  busy = false,
  disabled = false,
  label = 'Пригласить пользователя',
  variant = 'secondary',
  size,
  excludeUserId = null,
}) {
  const selectRef = useRef(null);

  const candidates = (users || []).filter((u) => {
    if (!u) return false;
    const idRaw = u.id ?? u.user_id ?? u.userId;
    const id = idRaw != null && Number.isFinite(Number(idRaw)) ? Number(idRaw) : null;
    if (excludeUserId != null && id != null && Number(excludeUserId) === id) return false;
    return id != null;
  });

  const openPicker = () => {
    const el = selectRef.current;
    if (!el || disabled || busy || candidates.length === 0) return;
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker();
        return;
      } catch {
        /* fall through */
      }
    }
    el.click();
  };

  const handleChange = async (e) => {
    const uid = e.target.value ? Number(e.target.value) : null;
    e.target.value = '';
    if (!uid || Number.isNaN(uid) || busy) return;
    await onInvite?.(uid);
  };

  return (
    <span className="invite-user-button-wrap" style={{ display: 'inline-block', position: 'relative' }}>
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={disabled || busy || candidates.length === 0}
        onClick={openPicker}
      >
        {busy ? 'Отправляю…' : label}
      </Button>
      <select
        ref={selectRef}
        className="invite-user-button-select"
        value=""
        onChange={handleChange}
        disabled={disabled || busy}
        aria-hidden="true"
        tabIndex={-1}
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        <option value="" disabled>
          Выберите пользователя
        </option>
        {candidates.map((u) => {
          const id = u.id ?? u.user_id ?? u.userId;
          return (
            <option key={id} value={id}>
              {formatUserLabel(u)}
            </option>
          );
        })}
      </select>
    </span>
  );
}
