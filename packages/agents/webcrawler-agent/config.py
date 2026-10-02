"""Configuration for WebCrawler Agent."""

import os
from functools import lru_cache

from pydantic_settings import BaseSettings


class Config(BaseSettings):
    """Agent configuration from environment variables."""

    aws_region: str = (
        os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or "ap-south-1"
    )
    session_storage_bucket_name: str = os.environ.get("SESSION_STORAGE_BUCKET_NAME", "")
    backend_table_name: str = os.environ.get("BACKEND_TABLE_NAME", "")
    agent_storage_bucket_name: str = os.environ.get("AGENT_STORAGE_BUCKET_NAME", "")
    # AgentStack sets BEDROCK_MODEL_ID from models.json `webcrawler`. The browser
    # tool returns text (screenshots are saved, not sent), so a text model works.
    bedrock_model_id: str = os.environ.get(
        "BEDROCK_MODEL_ID", "openai.gpt-oss-120b-1:0"
    )


@lru_cache
def get_config() -> Config:
    """Get cached configuration instance."""
    return Config()
