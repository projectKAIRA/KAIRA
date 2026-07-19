import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-semibold ring-offset-white transition-all duration-150 ease-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-[#1d1d1f] text-white shadow-cta hover:scale-[1.02] active:scale-[0.98]',
        ghost:
          'bg-black/[0.05] text-[#1d1d1f] border border-black/[0.06] hover:bg-black/[0.08] hover:-translate-y-px',
        outline:
          'border border-black/10 bg-white text-[#1d1d1f] hover:bg-black/[0.03]',
        link: 'text-[#0071e3] underline-offset-4 hover:underline p-0 h-auto',
      },
      size: {
        default: 'h-[46px] px-5 text-[15px]',
        sm: 'h-9 px-4 text-sm',
        lg: 'h-[54px] px-7 text-[17px]',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  }
);

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
});
Button.displayName = 'Button';

export { Button, buttonVariants };
