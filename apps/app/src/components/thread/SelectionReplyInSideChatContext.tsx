import { createContext, useContext } from "react";

export const SelectionReplyInSideChatContext = createContext<
  ((text: string) => void) | undefined
>(undefined);

export const SelectionReplyInOpenSideChatContext = createContext<
  ((text: string) => void) | undefined
>(undefined);

export function useSelectionReplyInSideChat() {
  return useContext(SelectionReplyInSideChatContext);
}

export function useSelectionReplyInOpenSideChat() {
  return useContext(SelectionReplyInOpenSideChatContext);
}
