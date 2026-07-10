import { createContext, useContext } from "react";

export interface RadioGroupContextValue {
  name: string;
  value: string | undefined;
  onSelect: (value: string) => void;
  disabled: boolean;
  invalid: boolean;
  describedBy: string | undefined;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

export const RadioGroupProvider = RadioGroupContext.Provider;

export function useRadioGroup(): RadioGroupContextValue {
  const context = useContext(RadioGroupContext);
  if (!context) {
    throw new Error("<Radio> must be rendered inside a <RadioGroup>.");
  }
  return context;
}
