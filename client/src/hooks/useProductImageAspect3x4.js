import { useEffect, useMemo, useState } from 'react';
import {
  imageMetaIs3x4,
  imagesAspectFingerprint,
  isSizeRatio3x4,
  parseProductImages,
  productImageDisplayUrl,
} from '../utils/productImage.js';

/** url → boolean (является 3:4) либо Promise */
const is3x4ByUrl = new Map();

function measureImageIs3x4(url) {
  const key = String(url || '');
  if (!key) return Promise.resolve(true);
  const cached = is3x4ByUrl.get(key);
  if (typeof cached === 'boolean') return Promise.resolve(cached);
  if (cached && typeof cached.then === 'function') return cached;

  const p = new Promise((resolve) => {
    if (typeof Image === 'undefined') {
      resolve(true);
      return;
    }
    const im = new Image();
    im.onload = () => {
      const ok = isSizeRatio3x4(im.naturalWidth, im.naturalHeight) === true;
      is3x4ByUrl.set(key, ok);
      resolve(ok);
    };
    im.onerror = () => {
      is3x4ByUrl.set(key, true);
      resolve(true);
    };
    im.src = key;
  });
  is3x4ByUrl.set(key, p);
  return p;
}

/** true, если это изображение точно не 3:4. */
export function useImageIsNot3x4(img) {
  const url = productImageDisplayUrl(img);
  const known = imageMetaIs3x4(img);
  const [measuredBad, setMeasuredBad] = useState(() => {
    if (known === false) return true;
    if (known === true || !url) return false;
    const cached = is3x4ByUrl.get(url);
    return typeof cached === 'boolean' ? cached === false : false;
  });

  useEffect(() => {
    if (known === false) {
      setMeasuredBad(true);
      return undefined;
    }
    if (known === true || !url) {
      setMeasuredBad(false);
      return undefined;
    }
    const cached = is3x4ByUrl.get(url);
    if (typeof cached === 'boolean') {
      setMeasuredBad(cached === false);
      return undefined;
    }
    let cancelled = false;
    measureImageIs3x4(url).then((ok) => {
      if (!cancelled) setMeasuredBad(ok === false);
    });
    return () => {
      cancelled = true;
    };
  }, [known, url, img?.width, img?.height, img?.aspect_3x4]);

  return known === false || measuredBad;
}

/** true, если хотя бы одно изображение товара не 3:4. Пустой набор — false. */
export function useProductHasNon3x4Image(images) {
  const fingerprint = imagesAspectFingerprint(images);
  // fingerprint encodes id/url/width/height/aspect; images identity is unstable
  const list = useMemo(
    () => parseProductImages(images),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fingerprint]
  );
  const knownBad = list.some((img) => imageMetaIs3x4(img) === false);
  const [measuredBad, setMeasuredBad] = useState(false);

  useEffect(() => {
    if (knownBad || list.length === 0) {
      setMeasuredBad(false);
      return undefined;
    }
    const unknown = list.filter((img) => imageMetaIs3x4(img) == null && productImageDisplayUrl(img));
    if (unknown.length === 0) {
      setMeasuredBad(false);
      return undefined;
    }
    let cancelled = false;
    Promise.all(unknown.map((img) => measureImageIs3x4(productImageDisplayUrl(img)))).then((oks) => {
      if (!cancelled) setMeasuredBad(oks.some((ok) => ok === false));
    });
    return () => {
      cancelled = true;
    };
  }, [knownBad, fingerprint, list]);

  return list.length > 0 && (knownBad || measuredBad);
}

export function ProductImageAspectFrame({
  img,
  className = '',
  style,
  title,
  as: Tag = 'div',
  children,
  ...rest
}) {
  const bad = useImageIsNot3x4(img);
  const cls = [className, bad ? 'is-bad-aspect' : ''].filter(Boolean).join(' ');
  return (
    <Tag
      className={cls || undefined}
      style={style}
      title={bad ? title || 'Соотношение сторон не 3:4' : title}
      {...rest}
    >
      {children}
    </Tag>
  );
}
