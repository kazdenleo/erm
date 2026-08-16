/** Совпадает с server/src/utils/marketplaceRichContent.js */
export const OZON_RICH_CONTENT_ATTR_ID = 11254;
export const OZON_SIZE_TABLE_ATTR_ID = 13164;

export function isOzonRichContentAttrId(id) {
  const n = Number(id);
  return n === OZON_RICH_CONTENT_ATTR_ID || n === OZON_SIZE_TABLE_ATTR_ID;
}
