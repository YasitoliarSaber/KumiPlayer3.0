/**
 * Slider（shadcn/ui 官方实现的 Radix 版本）。
 * 原型用它承载"海报墙列数（6–9）"与"看完判定阈值（50–100%）"。
 */

import * as React from 'react';
import { Slider as SliderPrimitive } from 'radix-ui';
import { cn } from '@/shared/lib/utils';

function Slider({ className, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn(
        'relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        className={cn(
          'block size-4 shrink-0 rounded-full border border-input bg-card shadow-sm transition-colors',
          'hover:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 outline-none disabled:pointer-events-none',
        )}
      />
    </SliderPrimitive.Root>
  );
}

export { Slider };
