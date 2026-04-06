FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy application code
COPY app/ ./app/

# Expose port
EXPOSE 8080

# Start server
CMD ["npm", "start"]