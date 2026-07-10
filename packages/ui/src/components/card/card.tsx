import { forwardRef } from "react";

import { cx } from "../../internal/cx";

import type { HTMLAttributes } from "react";

export type CardElevation = 0 | 1 | 2 | 3 | 4;

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  elevation?: CardElevation;
  /**
   * Adds hover and active affordances. The card stays a plain container: give the single primary
   * control inside it the `sf-card__action` class and its ::after will cover the whole card
   * surface. A card that is itself a button cannot contain any other control — see the README.
   */
  interactive?: boolean;
  as?: "div" | "article" | "section";
}

const CardRoot = forwardRef<HTMLDivElement, CardProps>(function Card(
  { elevation = 1, interactive = false, as: Component = "div", children, ...rest },
  ref,
) {
  return (
    <Component
      {...rest}
      ref={ref}
      data-elevation={elevation}
      className={cx("sf-card", interactive && "sf-card--interactive")}
    >
      {children}
    </Component>
  );
});

export type CardSectionProps = Omit<HTMLAttributes<HTMLDivElement>, "className">;

export const CardHeader = forwardRef<HTMLDivElement, CardSectionProps>(
  function CardHeader(props, ref) {
    return <div {...props} ref={ref} className="sf-card__header" />;
  },
);

export const CardBody = forwardRef<HTMLDivElement, CardSectionProps>(function CardBody(props, ref) {
  return <div {...props} ref={ref} className="sf-card__body" />;
});

export const CardFooter = forwardRef<HTMLDivElement, CardSectionProps>(
  function CardFooter(props, ref) {
    return <div {...props} ref={ref} className="sf-card__footer" />;
  },
);

export const Card = Object.assign(CardRoot, {
  Header: CardHeader,
  Body: CardBody,
  Footer: CardFooter,
});
