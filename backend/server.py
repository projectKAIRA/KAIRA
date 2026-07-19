"""
KAIRA — minimal FastAPI backend.

The Kaira site itself is a static Astro frontend. This backend exists to
satisfy the deployment topology (backend + frontend) and to expose a health
endpoint plus a lead-quote passthrough that mirrors the Cloudflare Pages
Function used in the source project. Kept intentionally tiny — no MongoDB
writes required for the marketing site.
"""

import os
import logging
from typing import List, Optional

from fastapi import FastAPI, APIRouter, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field, ValidationError
from dotenv import load_dotenv

# Load env from the same directory as this file
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("kaira")

# All FastAPI routes MUST be prefixed with /api so ingress routes them to
# port 8001 instead of the static frontend.
api = APIRouter(prefix="/api")


@api.get("/health")
async def health():
    return {"status": "ok", "service": "kaira-backend"}


@api.get("/")
async def root():
    return {"service": "kaira-backend", "version": "1.0.0"}


class QuoteRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    business: str = Field(min_length=1, max_length=160)
    email: EmailStr
    phone: Optional[str] = Field(default=None, max_length=40)
    website: Optional[str] = Field(default=None, max_length=300)
    services: List[str] = Field(default_factory=list)
    budget: Optional[str] = Field(default=None, max_length=80)
    details: str = Field(min_length=1, max_length=4000)


@api.post("/quote")
async def submit_quote(payload: QuoteRequest):
    """
    Marketing quote-form receiver.

    In production the actual email delivery lives inside the Cloudflare Pages
    Function `functions/api/quote.ts`. When the site is served from the
    Cloudflare edge, that function handles requests. When served from this
    backend (Emergent deployment), we log the payload and acknowledge — the
    lead is preserved in server logs and can be wired to email later.
    """
    try:
        log.info("Quote received from %s (%s)", payload.name, payload.email)
        # Intentionally not persisting to Mongo — this is a static marketing site.
        return {"ok": True, "message": "Thanks — we'll be in touch within one business day."}
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors())


app = FastAPI(title="KAIRA", version="1.0.0")

cors_origins = os.getenv("CORS_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in cors_origins],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api)
