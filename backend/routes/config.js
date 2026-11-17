/**
 * Rota GET /api/config (CONTRACTS.md §5).
 */

import { Router } from "express";
import { getPublicConfig } from "../utils/configLoader.js";

const router = Router();

router.get("/", (_req, res) => {
  res.json(getPublicConfig());
});

export default router;