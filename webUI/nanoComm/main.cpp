#include <iostream>
#include <array>
#include <cerrno>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <nlohmann/json.hpp>
#include <cmath>
#include <thread>
#include <chrono>

#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <unistd.h>

#include <fcntl.h>
#include <termios.h>
#include <unistd.h>

#include <nlohmann/json.hpp>

namespace fs = std::filesystem;
using json = nlohmann::json;


struct Position {
    float x, y;
};


void markString(std::string &curString) {
    curString += '\n';
    curString.insert(0, "$");
}


//cmd 1 = jednoduchy move, cmd 0 = ping a otestovani, cmd 2 = nastaveni rychlosti spindl, cmd 3 = homing
struct basicCMD {
    uint8_t command;
    Position position;
    float z, speed;

    basicCMD(uint8_t cmd = 0, Position position = {-1, -1}, float z = -1, float speed = -1) {
        this->command = cmd;
        this->position = position;
        this->z = z;
        this->speed = speed;
    }

    void prepareForNano(char buffer[], size_t bufSize) {
        std::string prepareString;
        prepareString += std::to_string(command);
        prepareString += ';';
        prepareString += std::to_string(position.x);
        prepareString += ';';
        prepareString += std::to_string(position.y);
        prepareString += ';';
        prepareString += std::to_string(z);
        prepareString += ';';
        prepareString += std::to_string(speed);
        prepareString += ';';
        markString(prepareString);
        if (prepareString.length() >= bufSize) {
            std::cout << "[UART] Prepared command is too long for UART buffer and will be truncated. Length: "
                      << prepareString.length() << ", buffer size: " << bufSize << "." << std::endl;
        }
        std::strncpy(buffer, prepareString.c_str(), bufSize - 1);
        buffer[bufSize - 1] = '\0';
    }
};


// error 0 = ok, error 1 = neco ....
// status 0 = zprava od nana, status 1 = zprava od nanoComm
struct nanoReport {
    uint8_t status;
    uint8_t error;
    Position position;
    float z;
    float speed, spindlSpeed;

    nanoReport(uint8_t status = 0, uint8_t error = 0, Position position = {0, 0}, float z = 0, float speed = 0, float spindlSpeed = 0) {
        this->status = status;
        this->error = error;
        this->position = position;
        this->z = z;
        this->speed = speed;
        this->spindlSpeed = spindlSpeed;
    }
};


NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE(Position, x, y);

NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE(nanoReport, status, error, position, z, speed, spindlSpeed);


float loadNumberForData(int &currentChar, std::string &text) {
    float oneNumber = 0;
    float floatinDecimal = 0;
    bool negativity = false;
    bool fullNum = false;
    char curChar = ' ';

    while (currentChar < text.length()) {
        curChar = text[currentChar];
        if (std::isdigit(curChar)) {
            break;
        }

        if (curChar == '-') {
            negativity = true;
        }

        currentChar += 1;
    }

    while (currentChar < text.length()) {
        curChar = text[currentChar];
        if (!(std::isdigit(curChar)) && !(curChar == '.')) {
            break;
        }

        if (curChar == '.' && !fullNum) {
            fullNum = true;
            currentChar += 1;
            continue;
        }

        if (fullNum) {
            floatinDecimal += 1;
        }

        oneNumber *= 10;
        oneNumber += int(curChar - '0');
        currentChar += 1;

        if (currentChar >= text.length()) {
            break;
        }
    }

    oneNumber /= std::pow(10, floatinDecimal);
    if (negativity) {
        oneNumber *= -1;
    }

    return oneNumber;
}

bool reportHasDelimiter(const std::string &curString, int curChar, const char *fieldName) {
    if (curChar >= static_cast<int>(curString.length())) {
        std::cout << "[UART] Malformed Nano report: missing delimiter after " << fieldName << "." << std::endl;
        return false;
    }

    if (curString[curChar] != ',') {
        std::cout << "[UART] Malformed Nano report: expected ',' after " << fieldName
                  << ", got '" << curString[curChar] << "'." << std::endl;
        return false;
    }

    return true;
}


void datafieng(std::string &curString, nanoReport &changeReport) {
    if (curString.empty()) {
        std::cout << "[UART] Malformed Nano report: empty payload." << std::endl;
        return;
    }

    int curChar = 0;
    changeReport.status = loadNumberForData(curChar, curString);
    if (reportHasDelimiter(curString, curChar, "status")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.error = loadNumberForData(curChar, curString);
    if (reportHasDelimiter(curString, curChar, "error")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.position.x = loadNumberForData(curChar, curString);
    if (reportHasDelimiter(curString, curChar, "x")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.position.y = loadNumberForData(curChar, curString);
    if (reportHasDelimiter(curString, curChar, "y")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.z = loadNumberForData(curChar, curString);
    if (reportHasDelimiter(curString, curChar, "z")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.speed = loadNumberForData(curChar, curString);
    if (reportHasDelimiter(curString, curChar, "speed")) {
        curChar += 1;
    }
    else {
        return;
    }
    changeReport.spindlSpeed = loadNumberForData(curChar, curString);
    return;
}


struct uartComm {
    std::string port;
    bool occupied;
    int baundWith;
    int serialID;

    uartComm(std::string port = "/dev/ttyUSB0", int baundWith = 9600) {
        this->port = port;
        occupied = false;
        this->baundWith = baundWith;
        serialID = -1;
    }

    void startComm() {
        serialID = open(port.c_str(), O_RDWR | O_NOCTTY);

        if (serialID < 0) {
            std::cout << "[UART] Unable to connect to port " << port << ": " << std::strerror(errno) << "." << std::endl;
            return;
        }

        termios tty;

        if (tcgetattr(serialID, &tty) != 0) {
            std::cout << "[UART] Unable to get port configuration for " << port << ": " << std::strerror(errno) << "." << std::endl;
            return;
        }

        speed_t speed;

        if (baundWith == 115200) {
            speed = B115200;
        } else if (baundWith == 9600) {
            speed = B9600;
        } else {
            std::cout << "[UART] Unsupported baud rate " << baundWith << ", falling back to 9600." << std::endl;
            speed = B9600;
        }

        cfsetospeed(&tty, speed);
        cfsetispeed(&tty, speed);

        tty.c_cflag &= ~PARENB;
        tty.c_cflag &= ~CSTOPB;
        tty.c_cflag &= ~CSIZE;
        tty.c_cflag |= CS8;

        tty.c_cflag &= ~CRTSCTS;

        tty.c_cflag |= CREAD | CLOCAL;

        tty.c_lflag &= ~ICANON;
        tty.c_lflag &= ~ECHO;
        tty.c_lflag &= ~ISIG;
        tty.c_oflag &= ~OPOST;

        tty.c_cc[VMIN]  = 0;
        tty.c_cc[VTIME] = 1;

        if (tcsetattr(serialID, TCSANOW, &tty) != 0) {
            std::cerr << "[UART] Unable to save port configuration for " << port << ": " << std::strerror(errno) << "." << std::endl;
            return;
        }

        std::cout << "[UART] Port " << port << " successfully opened at " << baundWith << " baud." << std::endl;
    }

    void sendBasicCMD(basicCMD cmd) {
        (void)cmd;
        occupied = true;

        if (serialID == -1) {
            std::cout << "[UART] Cannot send command: serial port is not open." << std::endl;
            occupied = false;
            return;
        }
        
        char buffer[64] = {};
        cmd.prepareForNano(buffer, sizeof(buffer));
        ssize_t result = write(serialID, buffer, sizeof(buffer));
        if (result < 0) {
            std::cout << "[UART] Failed to write command to " << port << ": " << std::strerror(errno) << "." << std::endl;
        }
        else if (result < static_cast<ssize_t>(sizeof(buffer))) {
            std::cout << "[UART] Partial command write to " << port << ": wrote " << result
                      << " of " << sizeof(buffer) << " bytes." << std::endl;
        }
        occupied = false;
    }

    nanoReport listenUART() {
        if (!occupied) {
            occupied = true;
            nanoReport data = nanoReport(1, 0);

            if (serialID == -1) {
                std::cout << "[UART] Cannot listen: serial port is not open." << std::endl;
                occupied = false;
                return nanoReport(1, 7);
            }

            std::string readBuffer = "";
            char buffer[64] = {};
            ssize_t result;
            bool started = false;

            while (true) {
                result = read(serialID, buffer, 64);

                if (result == 0) {
                    std::cout << "[UART] Read timeout while waiting for Nano report on " << port << "." << std::endl;
                    continue;
                }

                if (result < 0) {
                    close(serialID);
                    serialID = -1;
                    occupied = false;
                    std::cout << "[UART] Arduino disconnected while reading command on port " << port << "." << std::endl;
                    return nanoReport(1, 6);
                }

                std::string currentData = std::string(buffer, result);

                if (!started) {
                    size_t startChar = currentData.find('$');

                    if (startChar == std::string::npos) {
                        std::cout << "[UART] Ignoring data without start marker on port " << port << "." << std::endl;
                        continue;
                    }

                    else {
                        started = true;
                        currentData.erase(0, startChar + 1);
                    }
                }


                if (started) {
                    size_t endChar = currentData.find('\n');

                    if (endChar == std::string::npos) {
                        readBuffer.append(currentData);
                        continue;
                    }

                    else {
                        currentData.erase(endChar, 64);
                        readBuffer.append(currentData);
                        break;
                    }
                }

            }
            occupied = false;
            std::cout << "[UART] Received Nano report payload: " << readBuffer << std::endl;
            datafieng(readBuffer, data);
            return data;
        }
        std::cout << "[UART] Cannot listen: UART is already occupied." << std::endl;
        return nanoReport(1, 2);
    }
};


struct gcodeDecoder {
    std::string gcodeText;
    size_t currentChar = 0;
    std::array<char, 2> commandChars = {'G', 'M'};
    std::array<char, 7> instructionChars = {'X', 'Y', 'Z', 'I', 'J', 'F', 'S'};

    gcodeDecoder(std::string gcodeText = "") {
        this->gcodeText = gcodeText;
    }

    bool contains() {
        if (gcodeText[currentChar] == instructionChars[0] ||  gcodeText[currentChar] == instructionChars[1] || gcodeText[currentChar] == instructionChars[2] ||
            gcodeText[currentChar] == instructionChars[3] || gcodeText[currentChar] == instructionChars[4] || gcodeText[currentChar] == instructionChars[5] || gcodeText[currentChar] == instructionChars[6]) {
            return true;
        }
        return false;
    }

    float loadNumber() {
        float oneNumber = 0;
        float floatinDecimal = 0;
        bool negativity = false;
        bool fullNum = false;
        char curChar = ' ';

        while (currentChar < gcodeText.length()) {
            curChar = gcodeText[currentChar];
            if (std::isdigit(curChar)) {
                break;
            }

            if (curChar == '-') {
                negativity = true;
            }

            currentChar += 1;
        }

        while (currentChar < gcodeText.length()) {
            curChar = gcodeText[currentChar];
            if (!(std::isdigit(curChar)) && !(curChar == '.')) {
                break;
            }

            if (curChar == '.' && !fullNum) {
                fullNum = true;
                currentChar += 1;
                continue;
            }

            if (fullNum) {
                floatinDecimal += 1;
            }

            oneNumber *= 10;
            oneNumber += int(curChar - '0');
            currentChar += 1;

            if (currentChar >= gcodeText.length()) {
                break;
            }
        }

        oneNumber /= std::pow(10, floatinDecimal);
        if (negativity) {
            oneNumber *= -1;
        }

        return oneNumber;
    }

    int determineCMD(char curChar, int curNum) {
        if (curChar == 'G') {
            if (curNum == 1) {
                return 1;
            }

            else if (curNum == 20) {
                std::cout << "[GCODE] G20 inch units are not implemented yet." << std::endl;
            }

            else if (curNum == 21) {
                std::cout << "[GCODE] G21 millimeter units are not implemented yet." << std::endl;
            }

            else if (curNum == 90) {
                std::cout << "[GCODE] G90 absolute positioning is not implemented yet." << std::endl;
            }

            else if (curNum == 91) {
                std::cout << "[GCODE] G91 relative positioning is not implemented yet." << std::endl;
            }
        }

        else if (curChar == 'M') {
            if (curNum == 3) {
                return 2;
            }
            else if (curNum == 5) {
                return 5;
            }
            else if (curNum == 30) {
                return 4;
            }
        }
        std::cout << "[GCODE] Unsupported command: " << curChar << curNum << std::endl;
        return 254;
    }

    void createCMD(basicCMD &cmd, float number) {
        if (gcodeText[currentChar] == instructionChars[0]) {
            cmd.position.x = number;
        }
        else if (gcodeText[currentChar] == instructionChars[1]) {
            cmd.position.y = number;
        }
        else if (gcodeText[currentChar] == instructionChars[2]) {
            cmd.z = number;
        }
        else if (gcodeText[currentChar] == instructionChars[5]) {
            cmd.speed = number;
        }
        else if (gcodeText[currentChar] == instructionChars[6]) {
            cmd.speed = number;
        }
    }

    basicCMD nextInstr() {
        bool firstCmd = true;
        basicCMD generatedCMD = basicCMD();
        while (true) {
            if (gcodeText.length() <= currentChar) {
                generatedCMD.command = 255;
                std::cout << "[GCODE] End of G-code reached." << std::endl;
                break;
            }

            if (gcodeText[currentChar] == commandChars[0] || gcodeText[currentChar] == commandChars[1]) {
                if (firstCmd) {
                    firstCmd = false;
                    generatedCMD.command = determineCMD(gcodeText[currentChar], int(loadNumber()));
                    continue;
                }
                break;
            }

            if (contains()) {
                createCMD(generatedCMD, loadNumber());
            }

            currentChar += 1;
        }
        return generatedCMD;
    }
};


struct tcpCommUser {
    int port, serverID, socketID;
    std::string readBuffer;
    char startCharr, endCharr, stopCharr, pauseCharr;

    tcpCommUser(int port = 5000) {
        this->port = port;
        serverID = -1;
        socketID = -1;
        startCharr = '$';
        endCharr = '\n';
        stopCharr = '#';
        pauseCharr = ';';
    }

    void startServer() {
        sockaddr_in address = sockaddr_in();
        int opt = 1;

        serverID = socket(AF_INET, SOCK_STREAM, 0);
        if (serverID < 0) {
            std::cerr << "[TCP] Failed to create server socket on port " << port << ": " << std::strerror(errno) << std::endl;
            exit(EXIT_FAILURE);
        }

        if (setsockopt(serverID, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
            std::cerr << "[TCP] Failed to configure SO_REUSEADDR on port " << port << ": " << std::strerror(errno) << std::endl;
            exit(EXIT_FAILURE);
        }

        address.sin_family = AF_INET;
        address.sin_addr.s_addr = INADDR_ANY;
        address.sin_port = htons(port);

        if (bind(serverID, (sockaddr*)&address, sizeof(address)) < 0) {
            std::cerr << "[TCP] Failed to bind server socket on port " << port << ": " << std::strerror(errno) << std::endl;
            exit(EXIT_FAILURE);
        }

        if (listen(serverID, 3) < 0) {
            std::cerr << "[TCP] Failed to listen on port " << port << ": " << std::strerror(errno) << std::endl;
            exit(EXIT_FAILURE);
        }
    }


    void waitForBackend() {
        sockaddr_in address = sockaddr_in();
        int addrSize = sizeof(address);
        std::cout << "[TCP] Waiting for backend connection on port " << port << "..." << std::endl;

        socketID = accept(serverID, (sockaddr*)&address, (socklen_t*)&addrSize);

        if (socketID < 0) {
            std::cout << "[TCP] Backend connection failed on port " << port << ": " << std::strerror(errno) << std::endl;
        }
        else {
            std::cout << "[TCP] Backend connected on port " << port << "." << std::endl;
        }
    }


    void sendData(nanoReport report) {
        if (socketID < 0) {
            std::cout << "[TCP] Cannot send report: backend is not connected on port " << port << "." << std::endl;
            return;
        }
        json rawJson = report;
        std::string rawText = rawJson.dump();
        rawText.insert(0, "$");
        rawText += '\n';

        size_t sentBytes = 0;
        while (sentBytes < rawText.length()) {
            ssize_t result = send(socketID, rawText.data() + sentBytes, rawText.length() - sentBytes, 0);

            if (result < 0 && errno == EINTR) {
                std::cout << "[TCP] Send interrupted by signal, retrying on port " << port << "." << std::endl;
                continue;
            }

            if (result <= 0) {
                close(socketID);
                socketID = -1;
                std::cout << "[TCP] Backend disconnected while sending report on port " << port << "." << std::endl;
                return;
            }

            sentBytes += result;
        }
    }


    json readData() {
        if (socketID < 0) {
            std::cout << "[TCP] Cannot read command: backend is not connected on port " << port << "." << std::endl;
            return nullptr;
        }

        readBuffer = "";
        char buffer[1024] = {};
        ssize_t result;
        bool started = false;

        while (true) {
            result = read(socketID, buffer, 1024);

            if (result <= 0) {
                close(socketID);
                socketID = -1;
                std::cout << "[TCP] Backend disconnected while reading command on port " << port << "." << std::endl;
                return nullptr;
            }

            std::string currentData = std::string(buffer, result);

            if (!started) {
                size_t startChar = currentData.find(startCharr);

                if (startChar == std::string::npos) {
                    std::cout << "[TCP] Ignoring data without start marker on port " << port << "." << std::endl;
                    continue;
                }

                else {
                    started = true;
                    currentData.erase(0, startChar + 1);
                }
            }


            if (started) {
                size_t endChar = currentData.find(endCharr);

                if (endChar == std::string::npos) {
                    readBuffer.append(currentData);
                    continue;
                }

                else {
                    currentData.erase(endChar, 1024);
                    readBuffer.append(currentData);
                    break;
                }
            }

        }

        try {
            json returnJson = json::parse(readBuffer);
            return returnJson;
        } catch (const json::parse_error& error) {
            std::cout << "[TCP] Invalid JSON command on port " << port << ": " << error.what() << std::endl;
            return nullptr;
        }
    }

    bool socketHasDataNow(int socketID) {
        fd_set readSet;
        FD_ZERO(&readSet);
        FD_SET(socketID, &readSet);

        timeval timeout;
        timeout.tv_sec = 0;
        timeout.tv_usec = 0;

        int result = select(socketID + 1, &readSet, nullptr, nullptr, &timeout);
        if (result < 0) {
            std::cout << "[TCP] Failed to poll emergency socket on port " << port << ": " << std::strerror(errno) << std::endl;
        }

        return result > 0 && FD_ISSET(socketID, &readSet);
    }


    int readEmergency() {
        if (socketID < 0) {
            std::cout << "[TCP] Cannot read emergency command: backend is not connected on port " << port << "." << std::endl;
            return -1;
        }
        char buffer[1024] = {};
        ssize_t size = 10;
        int returnValue = 0;

        while (socketHasDataNow(socketID)) {
            size = read(socketID, buffer, 1024);
            if (size <= 0) {
                close(socketID);
                socketID = -1;
                std::cout << "[TCP] Backend disconnected while reading emergency command on port " << port << "." << std::endl;
                return -1;
            }

            std::string current = std::string(buffer, size);
            if (current.find(pauseCharr) != std::string::npos && !(returnValue == 5)) {
                std::cout << "[EMERGENCY] Soft stop requested by backend." << std::endl;
                returnValue = 4;
            }
            if (current.find(stopCharr) != std::string::npos) {
                std::cout << "[EMERGENCY] End command requested by backend." << std::endl;
                returnValue = 5;
            }
        }
        return returnValue;
    }
};


struct communicator {
    uartComm myUART;
    gcodeDecoder myDec;
    tcpCommUser myTCPUser;
    tcpCommUser myEmergencyUser;
    nanoReport savedReport;
    int rememberedChar;

    communicator(fs::path port) {
        this->myUART = uartComm(port);
        myTCPUser = tcpCommUser(5000);
        myEmergencyUser = tcpCommUser(5001);
    }

    void setup() {
        std::cout << "[SETUP] Starting command/report TCP server." << std::endl;
        try {
            myTCPUser.startServer();
            std::cout << "[SETUP] Command/report TCP server started successfully." << std::endl;
        } catch (...) {
            std::cout << "[SETUP] Command/report TCP server setup failed." << std::endl;
            return;
        }
        std::cout << "[SETUP] Waiting for backend on port " << myTCPUser.port << "." << std::endl;
        myTCPUser.waitForBackend();
        std::cout << "[SETUP] Starting emergency TCP server." << std::endl;
        try {
            myEmergencyUser.startServer();
            std::cout << "[SETUP] Emergency TCP server started successfully." << std::endl;
        } catch (...) {
            std::cout << "[SETUP] Emergency TCP server setup failed." << std::endl;
            return;
        }
        std::cout << "[SETUP] Waiting for backend emergency connection on port " << myEmergencyUser.port << "." << std::endl;
        myEmergencyUser.waitForBackend();
        std::cout << "[SETUP] TCP communication initialized successfully." << std::endl;

        myUART.startComm();
    }


    bool doGcodeTask(gcodeDecoder &decoder) {
        nanoReport curReport = myUART.listenUART();
        int message = myEmergencyUser.readEmergency();
        myTCPUser.sendData(curReport);
        basicCMD cmd = decoder.nextInstr();

        if (curReport.error != 0) {
            std::cout << "[UART] Arduino reported error code " << static_cast<int>(curReport.error) << "." << std::endl;
            return false;
        }

        if (message == 4 || message == 5) {
            std::cout << "[GCODE] Stopping current G-code task because emergency command " << message << " was received." << std::endl;
            cmd.command = message;
            myUART.sendBasicCMD(cmd);
            savedReport = curReport;
            return false;
        }

        if (cmd.command == 255) {
            std::cout << "[GCODE] Current G-code task finished." << std::endl;
            return false;
        }

        myUART.sendBasicCMD(cmd);
        return true;
    }


    void gcodeSender(fs::path gcodePath) {
        myUART.sendBasicCMD(basicCMD(0, {-1,-1}, -1, -1));
        bool advance = true;
        std::ifstream file(gcodePath);

        if (!file) {
            myTCPUser.sendData(nanoReport(1, 1));
            std::cout << "[GCODE] File does not exist: " << gcodePath << std::endl;
            return;
        }

        std::stringstream buffer;
        buffer << file.rdbuf();
        gcodeDecoder decoder = gcodeDecoder(buffer.str());

        while (advance) {
            advance = doGcodeTask(decoder);
        }
    }


    void operateCommunicator() {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        json newestTask = myTCPUser.readData();
        if (newestTask.is_null()) {
            std::cout << "[TASK] No valid task received from backend." << std::endl;
            return;
        }

        if (!newestTask.contains("cmd") || !newestTask["cmd"].is_number_integer()) {
            std::cout << "[TASK] Invalid task: missing numeric 'cmd' field." << std::endl;
            return;
        }

        if (!newestTask.is_null() && newestTask.contains("cmd")) {
            switch (newestTask["cmd"].get<int>()) {
                case 1: {
                    if (newestTask.contains("x") && newestTask.contains("y") && newestTask.contains("z")) {
                        if (newestTask["x"].is_number() && newestTask["y"].is_number() && newestTask["z"].is_number()) {
                            myUART.sendBasicCMD(basicCMD(1, {newestTask["x"].get<float>(), newestTask["y"].get<float>()}, newestTask["z"].get<float>()));
                        }
                        else {
                            std::cout << "[TASK] Invalid move task: x, y, and z must be numbers." << std::endl;
                        }
                    }
                    else {
                        std::cout << "[TASK] Invalid move task: missing x, y, or z field." << std::endl;
                    }
                    break;
                }
                case 2: {
                    myUART.sendBasicCMD(basicCMD(3));
                    break;
                };
                case 3:
                    if (newestTask.contains("path") && newestTask["path"].is_string()) {
                        gcodeSender(newestTask["path"].get<fs::path>());
                    }
                    else {
                        std::cout << "[TASK] Invalid G-code task: missing string 'path' field." << std::endl;
                    }
                    break;
                default:
                    std::cout << "[TASK] Unsupported task command: " << newestTask["cmd"].get<int>() << std::endl;
                    break;
            }
        }
    }
};


int main() {
    communicator myCommunicator = communicator("/dev/ttyUSB0");
    myCommunicator.setup();
    while (true) {
        myCommunicator.operateCommunicator();
    }

    return 0;
}
