import { createContext, useContext, useState } from "react";

/**
 * Whether admin cards start expanded. The admin navigation shows one section
 * at a time and opens its cards right away; elsewhere cards start collapsed.
 */
export const AdminCardDefaultOpenContext = createContext(false);

export function useAdminCardOpenState() {
  return useState(useContext(AdminCardDefaultOpenContext));
}
