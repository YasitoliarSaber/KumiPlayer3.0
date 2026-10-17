import type { ComponentProps, Ref } from 'react';
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';
import { cn } from '@/shared/lib/utils';

/** shadcn/Radix 原语：滚动仍由浏览器负责，只统一轨道与滑块外观。 */
function ScrollArea({ className, children, viewportRef, viewportProps, orientation = 'vertical', ...props }:
  ComponentProps<typeof ScrollAreaPrimitive.Root> & {
    readonly viewportRef?: Ref<HTMLDivElement>;
    readonly viewportProps?: ComponentProps<typeof ScrollAreaPrimitive.Viewport>;
    readonly orientation?: 'horizontal' | 'vertical';
  }) {
  return <ScrollAreaPrimitive.Root className={cn('relative overflow-hidden', className)} {...props}>
    <ScrollAreaPrimitive.Viewport {...viewportProps} ref={viewportRef}
      className={cn('size-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring/60', viewportProps?.className)}>
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar orientation={orientation} />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>;
}

function ScrollBar({ className, orientation = 'vertical', ...props }: ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>) {
  return <ScrollAreaPrimitive.Scrollbar orientation={orientation}
    className={cn('flex touch-none select-none p-px', orientation === 'vertical' ? 'h-full w-1.5' : 'h-1.5 flex-col', className)} {...props}>
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-foreground/25 hover:bg-foreground/40" />
  </ScrollAreaPrimitive.Scrollbar>;
}

export { ScrollArea, ScrollBar };
