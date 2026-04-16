export function splitFullName(fullName) {
  const raw = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!raw) {
    return { lastName: null, firstName: null, middleName: null };
  }
  const parts = raw.split(' ');
  return {
    lastName: parts[0] || null,
    firstName: parts[1] || null,
    middleName: parts.length > 2 ? parts.slice(2).join(' ') : null,
  };
}

export function buildFullName({ lastName, firstName, middleName }) {
  const parts = [lastName, firstName, middleName]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

export function normalizeUserNameFields(input = {}) {
  const hasStructuredFields =
    input.lastName !== undefined ||
    input.firstName !== undefined ||
    input.middleName !== undefined ||
    input.last_name !== undefined ||
    input.first_name !== undefined ||
    input.middle_name !== undefined;

  if (hasStructuredFields) {
    const lastName = input.lastName ?? input.last_name ?? null;
    const firstName = input.firstName ?? input.first_name ?? null;
    const middleName = input.middleName ?? input.middle_name ?? null;
    return {
      lastName: lastName != null && String(lastName).trim() !== '' ? String(lastName).trim() : null,
      firstName: firstName != null && String(firstName).trim() !== '' ? String(firstName).trim() : null,
      middleName: middleName != null && String(middleName).trim() !== '' ? String(middleName).trim() : null,
    };
  }

  return splitFullName(input.fullName ?? input.full_name ?? null);
}
