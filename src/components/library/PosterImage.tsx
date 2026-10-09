import { useContext, useEffect, useRef } from 'react';
import { defaultImageLifecycle, PosterImageContext } from './posterImageLifecycle';

export default function PosterImage({ path, width, src, alt, local }: {
  path: string; width: number; src: string; alt: string; local: boolean;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const lifecycle = useContext(PosterImageContext) || defaultImageLifecycle;
  useEffect(() => {
    const image = ref.current;
    if (!image || !lifecycle) return;
    image.dataset.state = 'idle';
    return lifecycle.register(image, { path, width, url: src, local });
  }, [lifecycle, path, width, src]);
  return <img ref={ref} alt={alt} className="poster-image poster-managed-image" decoding="async" />;
}
