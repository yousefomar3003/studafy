import { act, fireEvent, render, screen } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";

import { useCursorPagination } from "./use-cursor-pagination";

import type { CursorPage, FetchCursorPage } from "./use-cursor-pagination";

interface Item {
  id: string;
}

const PAGES: Record<string, CursorPage<Item>> = {
  start: { items: [{ id: "a" }, { id: "b" }], nextCursor: "page-2" },
  "page-2": { items: [{ id: "c" }], nextCursor: undefined },
};

function makeFetchPage(pages: Record<string, CursorPage<Item>> = PAGES): FetchCursorPage<Item> {
  return (cursor) => Promise.resolve(pages[cursor ?? "start"]);
}

function Harness({ fetchPage }: { fetchPage: FetchCursorPage<Item> }) {
  const { items, loading, error, hasNextPage, hasPreviousPage, goToNextPage, goToPreviousPage } =
    useCursorPagination(fetchPage);

  return (
    <div>
      <p data-testid="loading">{String(loading)}</p>
      <p data-testid="error">{error ? String(error) : ""}</p>
      <p data-testid="items">{items.map((item) => item.id).join(",")}</p>
      <button type="button" disabled={!hasNextPage} onClick={goToNextPage}>
        Next
      </button>
      <button type="button" disabled={!hasPreviousPage} onClick={goToPreviousPage}>
        Previous
      </button>
    </div>
  );
}

const flush = () => act(async () => undefined);

describe("useCursorPagination", () => {
  test("loads the first page on mount", async () => {
    render(<Harness fetchPage={makeFetchPage()} />);

    expect(screen.getByTestId("loading").textContent).toBe("true");
    await flush();

    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("items").textContent).toBe("a,b");
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("goToNextPage requests the page's nextCursor", async () => {
    render(<Harness fetchPage={makeFetchPage()} />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();

    expect(screen.getByTestId("items").textContent).toBe("c");
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("goToPreviousPage steps back through visited cursors without asking the server", async () => {
    const fetchPage = mock(makeFetchPage());
    render(<Harness fetchPage={fetchPage} />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await flush();

    expect(screen.getByTestId("items").textContent).toBe("a,b");
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls.at(-1)).toEqual([undefined]);
  });

  test("goToPreviousPage is a no-op on the first page", async () => {
    const fetchPage = mock(makeFetchPage());
    render(<Harness fetchPage={fetchPage} />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await flush();

    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  test("surfaces a rejected fetch as error and stops loading", async () => {
    const fetchPage: FetchCursorPage<Item> = () => Promise.reject(new Error("network down"));
    render(<Harness fetchPage={fetchPage} />);
    await flush();

    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(screen.getByTestId("error").textContent).toBe("Error: network down");
  });

  test("changing fetchPage identity resets to the first page", async () => {
    const { rerender } = render(<Harness fetchPage={makeFetchPage()} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    expect(screen.getByTestId("items").textContent).toBe("c");

    const otherPages: Record<string, CursorPage<Item>> = {
      start: { items: [{ id: "z" }], nextCursor: undefined },
    };
    rerender(<Harness fetchPage={makeFetchPage(otherPages)} />);
    await flush();

    expect(screen.getByTestId("items").textContent).toBe("z");
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("ignores a stale response when fetchPage changes mid-flight", async () => {
    let resolveStale: ((page: CursorPage<Item>) => void) | undefined;
    const staleFetch: FetchCursorPage<Item> = () =>
      new Promise((resolve) => {
        resolveStale = resolve;
      });

    const { rerender } = render(<Harness fetchPage={staleFetch} />);

    rerender(<Harness fetchPage={makeFetchPage()} />);
    await flush();
    expect(screen.getByTestId("items").textContent).toBe("a,b");

    await act(async () => {
      resolveStale?.({ items: [{ id: "stale" }] });
    });

    expect(screen.getByTestId("items").textContent).toBe("a,b");
  });
});
