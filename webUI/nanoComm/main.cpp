#include <iostream>
#include <cstdint>
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
#include <netinet/in.h>
#include <unistd.h>

#include <nlohmann/json.hpp>

namespace fs = std::filesystem;
using json = nlohmann::json;


struct Position {
    float x, y;
};


//cmd 1 = jednoduchy move, cmd 0 = ping a otestovani, cmd 2 = nastaveni rychlosti spindl, cmd 3 = homing
struct basicCMD {
    uint8_t command;
    Position position;
    float z, speed;
    float spindlSpeed;

    basicCMD(uint8_t cmd = 0, Position position = {-1, -1}, float z = -1, float speed = -1, float spindlSpeed = -1) {
        this->command = cmd;
        this->position = position;
        this->z = z;
        this->speed = speed;
        this->spindlSpeed = spindlSpeed;
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


struct uartComm {
    fs::path port;
    bool occupied;
    int baundWith;

    uartComm(fs::path port = "", int baundWith = 115200) {
        this->port = port;
        occupied = false;
        this->baundWith = baundWith;
    }

    void sendBasicCMD(basicCMD cmd) {
        (void)cmd;
        occupied = true;
        //sending data
        occupied = false;
    }

    nanoReport listenUART() {
        if (!occupied) {
            occupied = true;
            nanoReport data = nanoReport(1, 0);
            while (true) {
                //recieving data
                if (data.status == 0) {
                    break;
                }
            }
            occupied = false;
            return data;
        }
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

            }

            else if (curNum == 21) {

            }

            else if (curNum == 90) {

            }

            else if (curNum == 91) {

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
            cmd.spindlSpeed = number;
        }
    }

    basicCMD nextInstr() {
        bool firstCmd = true;
        basicCMD generatedCMD = basicCMD();
        while (true) {
            if (gcodeText.length() >= currentChar) {
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

    tcpCommUser(int port = 5000) {
        this->port = port;
    }

    void startServer() {
        sockaddr_in address;
        int opt = 1;

        serverID = socket(AF_INET, SOCK_STREAM, 0);
        if (serverID == 0) {
            std::cerr << "Socket selhal" << std::endl;
            exit(EXIT_FAILURE);
        }

        if (setsockopt(serverID, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) < 0) {
            std::cerr << "Setsockopt selhal" << std::endl;
            exit(EXIT_FAILURE);
        }

        address.sin_family = AF_INET;
        address.sin_addr.s_addr = INADDR_ANY;
        address.sin_port = htons(port);

        if (bind(serverID, (sockaddr*)&address, sizeof(address)) < 0) {
            std::cerr << "Bind portu selhal" << std::endl;
            exit(EXIT_FAILURE);
        }

        if (listen(serverID, 3) < 0) {
            std::cerr << "Listen selhal" << std::endl;
            exit(EXIT_FAILURE);
        }
    }


    void waitForBackend() {
        sockaddr_in address;
        int addrSize = sizeof(address);
        std::cout << "Čekám na připojení JS backendu... \n" << std::endl;

        socketID = accept(serverID, (sockaddr*)&address, (socklen_t*)&addrSize);

        if (socketID < 0) {
            std::cout << "Připojení se nezdařilo \n" << std::endl;
        }
        else {
            std::cout << "Připojení se zdařilo \n" << std::endl;
        }
    }

    void sendData(nanoReport report) {
        if (socketID < 0) {
            std::cout << "Nepřipojeno \n" << std::endl;
            return;
        }
        json rawJson = report;
        std::string rawText = rawJson.dump(4);
        const char* buffer = rawText.c_str();
        ssize_t errorVal = send(socketID, buffer, rawText.length(), 0);

        if (errorVal <= 0) {
            close(socketID);
            socketID = -1;
            std::cout << "Spadl backend \n" << std::endl;
            return;
        }
    }

    json readData() {
        if (socketID < 0) {
            std::cout << "Nepřipojeno \n" << std::endl;
            return nullptr;
        }

        char sendInfo[1024] = {0};
        ssize_t errorVal = read(socketID, sendInfo, 1024);

        if (errorVal <= 0) {
            close(socketID);
            socketID = -1;
            std::cout << "Spadl backend \n" << std::endl;
            return nullptr;
        }

        try {
            std::string text(sendInfo);
            return json::parse(text);
        } catch (...) {
            std::cout << "Backend neposlal json \n" << std::endl;
            return nullptr;
        }
    }
};


struct communicator {
    uartComm myUART;
    gcodeDecoder myDec;
    tcpCommUser myFileUser;
    int rememberedChar;

    communicator(fs::path port) {
        this->myUART = uartComm(port);
    }


    void determineEmergency(json &emergency, basicCMD &cmd, gcodeDecoder &decoder) {
        if (emergency["code"].get<int>() == 4) {
            cmd.command = 4;
            rememberedChar = decoder.currentChar;
        }
        else if (emergency["code"].get<int>() == 5) {
            cmd.command = 5;
        }
    }


    bool doGcodeTask(gcodeDecoder &decoder) {
        nanoReport curReport = myUART.listenUART();
        json message = myFileUser.readData();
        myFileUser.sendData(curReport);
        basicCMD cmd = decoder.nextInstr();

        if (curReport.error != 0) {
            return false;
        }

        if (!message.is_null() && message.contains("code")) {
            determineEmergency(message, cmd, decoder);
            myUART.sendBasicCMD(cmd);
            return false;
        }

        if (cmd.command == 255) {
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
            myFileUser.sendData(nanoReport(1, 1));
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
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        json newestTask = myFileUser.readData();
        if (!newestTask.is_null() && newestTask.contains("cmd")) {
            switch (newestTask["cmd"].get<int>()) {
                case 1: {
                    if (newestTask.contains("x") && newestTask.contains("y") && newestTask.contains("z")) {
                        if (newestTask["x"].is_number() && newestTask["y"].is_number() && newestTask["z"].is_number()) {
                            myUART.sendBasicCMD(basicCMD(1, {newestTask["x"].get<float>(), newestTask["y"].get<float>()}, newestTask["z"].get<float>()));
                        }
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
                    break;
            }
        }
    }
};


int main() {
    return 0;
}
