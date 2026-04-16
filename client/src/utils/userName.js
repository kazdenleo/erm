export function buildFullName({ lastName, firstName, middleName }) {
  return [lastName, firstName, middleName]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter(Boolean)
    .join(' ');
}

export function shortUserName(user) {
  if (!user) return '';
  const lastName = String(user.lastName ?? user.last_name ?? '').trim();
  const firstName = String(user.firstName ?? user.first_name ?? '').trim();
  const middleName = String(user.middleName ?? user.middle_name ?? '').trim();

  if (lastName || firstName || middleName) {
    const initials = [firstName, middleName]
      .filter(Boolean)
      .map((v) => `${v[0].toUpperCase()}.`)
      .join(' ');
    return [lastName, initials].filter(Boolean).join(' ').trim();
  }

  return String(user.fullName ?? user.full_name ?? user.email ?? '').trim();
}
