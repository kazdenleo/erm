import {
  buildUserNavFeatures,
  formStateToNavSections,
  navSectionKeyForPath,
  navSectionsToFormState,
  normalizeNavSections,
  parseNavSections,
  resolveNavSectionsForAccountRole,
  resolveNavSectionsForUser,
  roleNavSectionsToFormState,
} from '../src/utils/userNavSections.js';

describe('parseNavSections', () => {
  test('parses JSON string', () => {
    expect(parseNavSections('{"products":false}')).toEqual({ products: false });
  });

  test('returns empty object for invalid input', () => {
    expect(parseNavSections('not-json')).toEqual({});
    expect(parseNavSections(null)).toEqual({});
  });
});

describe('normalizeNavSections', () => {
  test('keeps only known keys', () => {
    expect(normalizeNavSections({ products: false, unknown: true })).toEqual({ products: false });
  });
});

describe('navSectionsToFormState / formStateToNavSections', () => {
  test('round-trips hidden sections', () => {
    const form = navSectionsToFormState({ products: false, orders: false });
    expect(form.products).toBe(false);
    expect(form.orders).toBe(false);
    expect(form.prices).toBe(true);
    expect(formStateToNavSections(form)).toEqual({ products: false, orders: false });
  });
});

describe('buildUserNavFeatures', () => {
  test('maps nav_sections to feature flags', () => {
    const features = buildUserNavFeatures({ products: false });
    expect(features.nav_products).toBe(false);
    expect(features.nav_orders).toBe(true);
  });
});

describe('resolveNavSectionsForAccountRole', () => {
  test('uses preset when role not configured in profile', () => {
    const resolved = resolveNavSectionsForAccountRole({}, 'picker');
    expect(resolved.products).toBe(false);
    expect(resolved.orders).not.toBe(false);
  });

  test('uses profile override when configured', () => {
    const resolved = resolveNavSectionsForAccountRole(
      { picker: { orders: false } },
      'picker'
    );
    expect(resolved.orders).toBe(false);
  });
});

describe('resolveNavSectionsForUser', () => {
  test('admin sees all sections', () => {
    expect(resolveNavSectionsForUser({ is_profile_admin: true }, {})).toEqual({});
  });

  test('user gets nav from profile role settings', () => {
    const nav = resolveNavSectionsForUser(
      { account_role: 'editor' },
      { role_nav_sections: { editor: { products: false } } }
    );
    expect(nav.products).toBe(false);
  });
});

describe('navSectionKeyForPath', () => {
  test('resolves main routes', () => {
    expect(navSectionKeyForPath('/products')).toBe('products');
    expect(navSectionKeyForPath('/')).toBe('analytics');
    expect(navSectionKeyForPath('/stock-levels/purchases')).toBe('warehouse_purchases');
    expect(navSectionKeyForPath('/settings/roles')).toBe('settings_users');
  });

  test('resolves warehouse op query', () => {
    expect(navSectionKeyForPath('/stock-levels/warehouse', '?op=inventory')).toBe('warehouse_inventory');
    expect(navSectionKeyForPath('/stock-levels/warehouse')).toBe('warehouse_stock');
  });
});

describe('roleNavSectionsToFormState', () => {
  test('builds form from preset', () => {
    const form = roleNavSectionsToFormState({}, 'picker');
    expect(form.products).toBe(false);
  });
});
