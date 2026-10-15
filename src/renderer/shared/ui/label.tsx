import * as React from 'react';
import { Label as LabelPrimitive } from 'radix-ui';
import { cn } from '@/shared/lib/utils';

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-[13px] font-medium text-foreground', className)}
      {...props}
    />
  );
}

export { Label };
