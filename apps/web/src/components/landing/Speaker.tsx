import Image from 'next/image';
import type { CSSProperties, ReactNode } from 'react';
import renders from './renders.json';

type View = 'front' | 'three-quarter';

/**
 * A rendered walnut speaker (scripts/render-speakers.ts): the cabinet still with the woofer cone as its own layer on
 * top, so CSS can pump the cone around its real centre. `level` (0–1) scales the pump; 0 holds the cone still.
 */
export function Speaker({
  view = 'front',
  level = 0.6,
  sizes,
  priority,
  className = '',
  alt = '',
  children,
}: {
  view?: View;
  level?: number;
  sizes: string;
  priority?: boolean;
  className?: string;
  alt?: string;
  /** drawn over the speaker; `--cx`/`--cy` put the woofer centre in reach (sync rings) */
  children?: ReactNode;
}) {
  const meta = renders[`${view}-cone`];
  const style = {
    aspectRatio: `${meta.w} / ${meta.h}`,
    '--cx': `${meta.cx * 100}%`,
    '--cy': `${meta.cy * 100}%`,
    '--amp': (0.06 * level).toFixed(4),
  } as CSSProperties;
  return (
    <div className={`spk ${className}`} style={style}>
      <Image src={`/landing/${view}-cabinet.webp`} alt={alt} width={meta.w} height={meta.h} sizes={sizes} priority={priority} />
      <Image
        src={`/landing/${view}-cone.webp`}
        alt=""
        aria-hidden
        width={meta.w}
        height={meta.h}
        sizes={sizes}
        priority={priority}
        className="spk-cone"
      />
      {children}
    </div>
  );
}
