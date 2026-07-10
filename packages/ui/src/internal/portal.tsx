import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { ReactNode } from "react";

export interface PortalProps {
  children: ReactNode;
}

/**
 * Mounts `children` into a container appended to <body>, and removes that container on unmount.
 * Modal and Toast both need to escape ancestor `overflow` and stacking contexts.
 *
 * The container is created during render rather than in an effect so that `children` mount in the
 * same commit as the Portal. A consumer that reads a ref on its portalled subtree in an effect —
 * Modal's focus trap does exactly this — would otherwise see `null`, because effects run once and
 * a container that only appears on a later pass never re-triggers them.
 */
export function Portal({ children }: PortalProps) {
  const [container] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );

  useLayoutEffect(() => {
    if (!container) {
      return;
    }
    document.body.append(container);
    return () => container.remove();
  }, [container]);

  return container ? createPortal(children, container) : null;
}
