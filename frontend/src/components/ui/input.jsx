import * as React from 'react';
import { cn } from '@/lib/utils';

const Input = React.forwardRef(({ className, type = 'text', ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      'mt-2 w-full rounded-xl border border-black/[0.08] bg-white px-4 py-3 text-sm text-[#1d1d1f] placeholder:text-[#86868b] placeholder:opacity-75 transition-colors duration-150 focus:border-[#0071e3] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/15',
      className
    )}
    {...props}
  />
));
Input.displayName = 'Input';

const Textarea = React.forwardRef(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'mt-2 w-full min-h-[120px] resize-y rounded-xl border border-black/[0.08] bg-white px-4 py-3 text-sm text-[#1d1d1f] placeholder:text-[#86868b] placeholder:opacity-75 transition-colors duration-150 focus:border-[#0071e3] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/15',
      className
    )}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

const Select = React.forwardRef(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'mt-2 w-full rounded-xl border border-black/[0.08] bg-white px-4 py-3 text-sm text-[#1d1d1f] transition-colors duration-150 focus:border-[#0071e3] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/15',
      className
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = 'Select';

const Label = React.forwardRef(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn('block text-sm font-semibold text-[#1d1d1f]', className)}
    {...props}
  />
));
Label.displayName = 'Label';

export { Input, Textarea, Select, Label };
