import { useContext, useEffect, useRef } from 'react';
import { getSharedImageLifecycle, PosterImageContext } from './posterImageLifecycle';

export default function PosterImage({ path, width, src, alt, local }: {
  path: string; width: number; src: string; alt: string; local: boolean;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const providedLifecycle = useContext(PosterImageContext);
  useEffect(() => {
    const image = ref.current;
    if (!image) return;
    const root = image.closest<HTMLElement>('.app-main');
    const lifecycle = providedLifecycle || getSharedImageLifecycle(root, root?.clientHeight || window.innerHeight);
    image.dataset.state = 'idle';
    return lifecycle.register(image, { path, width, url: src, local });
  }, [providedLifecycle, path, width, src]);
  return <img ref={ref} alt={alt} className="poster-image poster-managed-image" decoding="async" />;
}
