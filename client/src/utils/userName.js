export function buildFullName({ lastName, firstName, middleName }) {
  return [lastName, firstName, middleName]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter(Boolean)
    .join(' ');
}

/** «Иванов Иван Иванович» → { lastName, firstName, middleName } */
export function splitFullName(fullName) {
  const parts = String(fullName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { lastName: '', firstName: '', middleName: '' };
  return {
    lastName: parts[0] || '',
    firstName: parts[1] || '',
    middleName: parts.slice(2).join(' ') || '',
  };
}

export function shortUserName(user) {
  if (!user) return '';
  let lastName = String(user.lastName ?? user.last_name ?? '').trim();
  let firstName = String(user.firstName ?? user.first_name ?? '').trim();
  let middleName = String(user.middleName ?? user.middle_name ?? '').trim();

  if (!lastName && !firstName && !middleName) {
    const fromFull = splitFullName(user.fullName ?? user.full_name);
    lastName = fromFull.lastName;
    firstName = fromFull.firstName;
    middleName = fromFull.middleName;
  }

  if (lastName || firstName || middleName) {
    const initials = [firstName, middleName]
      .filter(Boolean)
      .map((v) => `${v[0].toUpperCase()}.`)
      .join('');
    return [lastName, initials].filter(Boolean).join(' ').trim();
  }

  return '';
}
