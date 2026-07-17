FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY app/ ./app/
RUN chown -R pwuser:pwuser /app

USER pwuser

# Expose port
EXPOSE 8080

# Start server
CMD ["npm", "start"]
