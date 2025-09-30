FROM node:20-bookworm-slim

# Install system dependencies for Manim, LaTeX, and rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv python3-dev \
    ffmpeg \
    libcairo2 libcairo2-dev \
    libpango-1.0-0 libpangocairo-1.0-0 libpango1.0-dev \
    libgdk-pixbuf-2.0-0 \
    libgl1 libegl1 \
    xvfb xauth \
    libgl1-mesa-dri libglu1-mesa mesa-utils \
    pkg-config build-essential \
    ghostscript \
    asymptote \
    texlive-latex-base texlive-latex-recommended texlive-latex-extra \
    texlive-fonts-recommended texlive-fonts-extra \
    latexmk dvisvgm cm-super \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Manim in a dedicated virtualenv (avoid PEP 668 managed env)
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
 && pip install --no-cache-dir manim==0.19.0 networkx

ENV NODE_ENV=production \
    PYTHON_BIN=python3

WORKDIR /app/manim-service

# Install Node dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy server code
COPY server.js ./

EXPOSE 8787

# Run as non-root for better security
USER node

CMD ["node", "server.js"]
