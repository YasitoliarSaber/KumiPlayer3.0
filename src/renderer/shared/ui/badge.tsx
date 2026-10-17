import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/shared/lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border bg-card text-muted-foreground',
        soft: 'border-transparent bg-accent text-accent-foreground',
        success: 'border-transparent bg-[var(--success-soft)] text-[var(--success)]',
        warning: 'border-transparent bg-[var(--warning-soft)] text-[var(--warning)]',
        danger: 'border-transparent bg-[var(--danger-soft)] text-[var(--destructive)]',
      },
    },
    defaultVariants: { variant: 'secondary' },
  },
);

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
