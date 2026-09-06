import clsx from 'clsx';
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import styles from './FormControls.module.css';

interface FieldChromeProps {
  label?: string;
  helper?: ReactNode;
  error?: string;
  children: (ariaProps: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => ReactNode;
}

const FieldChrome = ({ label, helper, error, children }: FieldChromeProps) => {
  const id = useId();
  const describedByID = useId();
  const describedBy = error !== undefined || helper !== undefined ? describedByID : undefined;

  return (
    <div className={styles.field}>
      {label !== undefined && (
        <label htmlFor={id} className={styles.label}>
          {label}
        </label>
      )}
      {children({
        id,
        'aria-invalid': error !== undefined ? true : undefined,
        'aria-describedby': describedBy,
      })}
      {error !== undefined ? (
        <p id={describedBy} className={styles.error}>
          {error}
        </p>
      ) : (
        helper !== undefined && (
          <p id={describedBy} className={styles.helper}>
            {helper}
          </p>
        )
      )}
    </div>
  );
};

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helper?: ReactNode;
  error?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, helper, error, className, ...rest },
  ref,
) {
  return (
    <FieldChrome label={label} helper={helper} error={error}>
      {(ariaProps) => (
        <input ref={ref} className={clsx(styles.input, className)} {...ariaProps} {...rest} />
      )}
    </FieldChrome>
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  helper?: ReactNode;
  error?: string;
  monospace?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, helper, error, monospace = false, className, ...rest },
  ref,
) {
  return (
    <FieldChrome label={label} helper={helper} error={error}>
      {(ariaProps) => (
        <textarea
          ref={ref}
          className={clsx(styles.textarea, monospace && styles.mono, className)}
          {...ariaProps}
          {...rest}
        />
      )}
    </FieldChrome>
  );
});
